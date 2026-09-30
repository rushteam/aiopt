// AiOpt domain model — the global provider pool and the target-agent registry.
//
// Pure types + constants, no side effects (like shared/appShortcuts.ts): imported
// by both the privileged main process and the untrusted renderer, so it must stay
// free of Node/Electron and of anything secret. API keys are NOT modeled here —
// they live in the main-only secret store, never in a Provider record.
//
// The core idea (vs. cc-switch): a provider is entered ONCE into a global pool and
// declares the wire formats it serves; each agent declares which formats it can
// consume. When the two sets overlap, the binding speaks that shared format natively
// (written directly, or through the proxy when proxy mode is on). When they do not,
// the pairing is legal only if the translation proxy can carry the agent's format to
// one of the provider's (see resolveBindingRoute); pairs it cannot translate are
// refused.

import type { AgentImportConfig } from './agentImport';
import type { OAuthProviderConfig, ProviderCredentialMode } from './oauthProviders';

/**
 * The wire format a provider speaks / an agent consumes.
 *
 * `openai` and `openai-responses` are DISTINCT dialects that share the OpenAI brand
 * but not the wire shape: `openai` is Chat Completions (`/v1/chat/completions`,
 * stateless `messages[]`), while `openai-responses` is the OpenAI Responses API
 * (`/responses`, `input`/`output` items, reasoning items). Agents that natively speak
 * Responses (codex, grok) must declare `openai-responses` — binding one to a Chat
 * Completions provider is a CROSS-format pairing routed through the translation proxy,
 * not a direct passthrough (codex would otherwise POST to a `/responses` endpoint the
 * Chat provider does not serve).
 */
export type ApiFormat = 'anthropic' | 'openai' | 'openai-responses' | 'gemini';

/**
 * Everything one agent's native config surface needs, when a pool provider CAN be
 * pointed at it. `null` binding marks a skills-only agent (see {@link AgentSpec}).
 */
export interface AgentBindingSpec {
  /** Provider formats this agent can consume (the binding compatibility gate). */
  acceptedFormats: readonly ApiFormat[];
  /**
   * How the agent's native config is rewritten: `exclusive` overwrites the active
   * provider, `additive` keeps every provider and only moves the default pointer.
   */
  mode: 'exclusive' | 'additive';
  /** Directory (relative to home) whose existence signals the agent is installed. */
  installDir: string;
  /**
   * The config files this agent reads, keyed by role, relative to home. This map is
   * the sole source of the write allowlist (see agentPaths.AGENT_FILES): only the exact
   * paths declared here may ever be written. Layouts are non-uniform on purpose — pi
   * keeps three files under `.pi/agent`, OpenCode lives under `.config/opencode`.
   */
  files: Readonly<Record<string, string>>;
}

/**
 * The single source of truth for one AI coding agent AiOpt knows about. Adding an
 * agent is one {@link AGENT_SPECS} record + one adapter module + one entry in
 * `BINDABLE_ADAPTER_FACTORIES` in `adapters/registry.ts` (see `docs/dev-rules/add-bindable-agent.md`).
 * The id union, runtime id list, display names, binding registry, skills map, and
 * write allowlist are all DERIVED from this table.
 */
export interface AgentSpec {
  /** Canonical display name (the one label used everywhere). */
  name: string;
  /**
   * The agent's global skills dir, relative to home, or `null` when AiOpt has no
   * well-known one (grok) — then it does not participate in Skills sync.
   */
  skillsDir: string | null;
  /**
   * Binding capability, or `null` for a skills-only agent. Not every agent can be
   * POINTED AT A POOL PROVIDER: it must expose a bring-your-own-endpoint surface (a
   * custom base URL + key it will honour). `cursor` is the exception — the Cursor CLI
   * only talks to Cursor's own backend (account login / `CURSOR_API_KEY`, Cursor-hosted
   * models), with no base-URL override — so its `binding` is `null`: it never appears in
   * the binding registry {@link AGENTS} or in Providers, but still joins Skills sync.
   */
  binding: AgentBindingSpec | null;
}

/**
 * The agent catalogue. Keep entries alphabetical by id — {@link AGENT_IDS} and
 * {@link AGENTS} preserve this order. `acceptedFormats` reflects each agent's native
 * config surface; revisit against upstream docs when wiring its adapter.
 */
export const AGENT_SPECS = {
  claude: {
    name: 'Claude Code',
    skillsDir: '.claude/skills',
    binding: {
      acceptedFormats: ['anthropic'],
      mode: 'exclusive',
      installDir: '.claude',
      files: { settings: '.claude/settings.json' },
    },
  },
  // Cline's CLI (3.x) takes the built-in openai-compatible provider slot: a single JSON
  // providers.json under ~/.cline/data/settings with baseUrl + apiKey + model. AiOpt takes
  // that slot, writes the model list into models.json beside it, and sets lastUsedProvider.
  cline: {
    name: 'Cline',
    skillsDir: null,
    binding: {
      acceptedFormats: ['openai'],
      mode: 'exclusive',
      installDir: '.cline',
      files: {
        providers: '.cline/data/settings/providers.json',
        models: '.cline/data/settings/models.json',
      },
    },
  },
  // codex/grok speak the OpenAI *Responses* API, not Chat Completions — see ApiFormat.
  codex: {
    name: 'Codex',
    skillsDir: '.codex/skills',
    binding: {
      acceptedFormats: ['openai-responses'],
      mode: 'exclusive',
      installDir: '.codex',
      files: { auth: '.codex/auth.json', config: '.codex/config.toml' },
    },
  },
  // Command Code keeps settings.json + a separate providers.json for custom providers.
  // The model field is "provider/model"; an AiOpt-bound model sets modelProvider too.
  commandcode: {
    name: 'Command Code',
    skillsDir: null,
    binding: {
      acceptedFormats: ['openai'],
      mode: 'exclusive',
      installDir: '.commandcode',
      files: {
        settings: '.commandcode/settings.json',
        providers: '.commandcode/providers.json',
      },
    },
  },
  // Copilot CLI / editor sign-in — import-only (no pool binding adapter yet).
  copilot: {
    name: 'GitHub Copilot',
    skillsDir: null,
    binding: null,
  },
  // Crush keeps a providers map in crush.json (type: "openai") with base_url + api_key,
  // and two model slots: models.large and models.small, each provider/model.
  crush: {
    name: 'Crush',
    skillsDir: null,
    binding: {
      acceptedFormats: ['openai'],
      mode: 'additive',
      installDir: '.config/crush',
      files: { config: '.config/crush/crush.json' },
    },
  },
  // Cursor can't bind a pool provider (no base-URL override), so `binding` is null; its
  // CLI still keeps skills under ~/.cursor/skills, so it joins the sync matrix.
  cursor: {
    name: 'Cursor',
    skillsDir: '.cursor/skills',
    binding: null,
  },
  // Devin only uses its own hosted models (no custom endpoint), so `binding` is null.
  devin: {
    name: 'Devin',
    skillsDir: null,
    binding: null,
  },
  // Droid (Factory) keeps customModels[] in settings.json, each with baseUrl + apiKey +
  // provider (anthropic|openai|generic-chat-completion-api). The startup model is
  // sessionDefaultSettings.model. AiOpt appends its models to the array.
  droid: {
    name: 'Droid',
    skillsDir: null,
    binding: {
      acceptedFormats: ['openai', 'openai-responses', 'anthropic'],
      mode: 'exclusive',
      installDir: '.factory',
      files: { settings: '.factory/settings.json' },
    },
  },
  // dsh (DeepSeek Harness) speaks three wire protocols per provider via its `api` field
  // (openai-completions←openai, openai-responses←openai-responses, anthropic-messages←anthropic;
  // see dshAdapter API_BY_FORMAT). Providers live in a `providers` DICT keyed by id, so like
  // Hermes/OpenCode it is additive; the secret goes in a separate credentials file (mode 0600).
  dsh: {
    name: 'DeepSeek Harness',
    skillsDir: '.dsh/skills',
    binding: {
      acceptedFormats: ['openai', 'openai-responses', 'anthropic'],
      mode: 'additive',
      installDir: '.dsh',
      files: { settings: '.dsh/settings.yaml', credentials: '.dsh/.credentials.yaml' },
    },
  },
  // fx (Vercel Labs) keeps providers in settings.json under "providers", each with
  // protocol + base_url + auth. The active provider is the top-level "provider" key.
  fx: {
    name: 'fx',
    skillsDir: null,
    binding: {
      acceptedFormats: ['openai'],
      mode: 'exclusive',
      installDir: '.fx',
      files: { settings: '.fx/settings.json' },
    },
  },
  gemini: {
    name: 'Gemini CLI',
    skillsDir: '.gemini/skills',
    binding: {
      acceptedFormats: ['gemini'],
      mode: 'exclusive',
      installDir: '.gemini',
      files: { env: '.gemini/.env', settings: '.gemini/settings.json' },
    },
  },
  // Goose (Block) reads GOOSE_PROVIDER/GOOSE_MODEL from config.yaml; only built-in
  // providers are supported (no custom base URL in config), so `binding` is null.
  goose: {
    name: 'Goose',
    skillsDir: null,
    binding: null,
  },
  // grok has no well-known skills dir (skillsDir null → absent from Skills sync).
  grok: {
    name: 'Grok',
    skillsDir: null,
    binding: {
      acceptedFormats: ['openai-responses'],
      mode: 'exclusive',
      installDir: '.grok',
      files: { config: '.grok/config.toml' },
    },
  },
  // Hermes (Nous Research) picks its wire protocol per provider via an `api_mode` field, so it
  // consumes several formats: chat_completions←openai, anthropic_messages←anthropic,
  // codex_responses←openai-responses (see hermesAdapter API_MODE_BY_FORMAT). Its config holds a
  // list of coexisting providers, so like OpenCode it is additive.
  hermes: {
    name: 'Hermes',
    skillsDir: '.hermes/skills',
    binding: {
      acceptedFormats: ['openai', 'anthropic', 'openai-responses'],
      mode: 'additive',
      installDir: '.hermes',
      files: { config: '.hermes/config.yaml' },
    },
  },
  // Kimi Code (Moonshot) keeps config.toml with [providers.<name>] tables and
  // [models."<key>"] tables, each naming a provider and the model to ask for.
  // default_model is the key of the model sessions start on.
  kimicode: {
    name: 'Kimi Code',
    skillsDir: null,
    binding: {
      acceptedFormats: ['openai'],
      mode: 'exclusive',
      installDir: '.kimi-code',
      files: { config: '.kimi-code/config.toml' },
    },
  },
  // MiMo Code (Xiaomi) is an OpenCode fork with the same config shape: provider map +
  // model pointer. Its config lives under ~/.config/mimocode (or $MIMOCODE_HOME/config).
  mimocode: {
    name: 'MiMo Code',
    skillsDir: null,
    binding: {
      acceptedFormats: ['openai', 'anthropic'],
      mode: 'additive',
      installDir: '.config/mimocode',
      files: { config: '.config/mimocode/mimocode.json' },
    },
  },
  // OmO (omo-ai) is a Pi fork with the same three-file layout under ~/.omo/agent.
  omo: {
    name: 'OmO',
    skillsDir: null,
    binding: {
      acceptedFormats: ['anthropic', 'openai', 'gemini'],
      mode: 'exclusive',
      installDir: '.omo',
      files: {
        auth: '.omo/agent/auth.json',
        models: '.omo/agent/models.json',
        settings: '.omo/agent/settings.json',
      },
    },
  },
  // omp (oh-my-pi) is Pi-derived: config.yml + models.yml under ~/.omp/agent, YAML
  // instead of JSON, with the same provider/model/auth structure as Pi.
  omp: {
    name: 'omp',
    skillsDir: null,
    binding: {
      acceptedFormats: ['anthropic', 'openai'],
      mode: 'exclusive',
      installDir: '.omp',
      files: {
        config: '.omp/agent/config.yml',
        models: '.omp/agent/models.yml',
      },
    },
  },
  opencode: {
    name: 'OpenCode',
    skillsDir: '.config/opencode/skills',
    binding: {
      acceptedFormats: ['openai', 'anthropic'],
      mode: 'additive',
      installDir: '.config/opencode',
      files: { config: '.config/opencode/opencode.json' },
    },
  },
  // OpenChamber (desktop front-end for OpenCode) keeps its own preferences under
  // ~/.config/openchamber but runs on OpenCode's config, so the binding goes into the
  // OpenCode config it reads. Treated as its own agent because it has a separate
  // preferences file and install dir.
  openchamber: {
    name: 'OpenChamber',
    skillsDir: null,
    binding: {
      acceptedFormats: ['openai', 'anthropic'],
      mode: 'additive',
      installDir: '.config/openchamber',
      files: { config: '.config/opencode/opencode.json' },
    },
  },
  pi: {
    name: 'pi',
    skillsDir: '.pi/agent/skills',
    binding: {
      acceptedFormats: ['anthropic', 'openai', 'gemini'],
      mode: 'exclusive',
      installDir: '.pi',
      files: {
        auth: '.pi/agent/auth.json',
        models: '.pi/agent/models.json',
        settings: '.pi/agent/settings.json',
      },
    },
  },
  // Qoder CLI keeps providers in settings.json under "providers" (openai protocol with
  // baseUrl + apiKey), and model.name as "provider/model". Needs a signed-in BYOK plan.
  qoder: {
    name: 'Qoder',
    skillsDir: null,
    binding: {
      acceptedFormats: ['openai'],
      mode: 'exclusive',
      installDir: '.qoder',
      files: { settings: '.qoder/settings.json' },
    },
  },
  // Qoder CN is Qoder's China-site build with its own accounts and config dir.
  qodercn: {
    name: 'Qoder CN',
    skillsDir: null,
    binding: {
      acceptedFormats: ['openai'],
      mode: 'exclusive',
      installDir: '.qoder-cn',
      files: { settings: '.qoder-cn/settings.json' },
    },
  },
  // WorkBuddy (Tencent CodeBuddy) takes custom models from ~/.workbuddy/models.json:
  // a list of OpenAI chat-completions models with url + apiKey. It watches the file
  // and picks up changes without a restart.
  workbuddy: {
    name: 'WorkBuddy',
    skillsDir: null,
    binding: {
      acceptedFormats: ['openai'],
      mode: 'additive',
      installDir: '.workbuddy',
      files: { models: '.workbuddy/models.json' },
    },
  },
  // ZCode (Zhipu) keeps providers in ~/.zcode/v2/config.json, OpenCode's shape with its
  // own "kind" field. An anthropic provider is asked at baseURL + /v1/messages.
  zcode: {
    name: 'ZCode',
    skillsDir: null,
    binding: {
      acceptedFormats: ['anthropic'],
      mode: 'additive',
      installDir: '.zcode',
      files: { config: '.zcode/v2/config.json' },
    },
  },
} as const satisfies Record<string, AgentSpec>;

/** Every agent id AiOpt knows about — the keys of {@link AGENT_SPECS}. */
export type AgentId = keyof typeof AGENT_SPECS;

/** Agent ids that declare a non-null {@link AgentSpec.binding} (pool bindable). */
export type BindableAgentId = {
  [K in AgentId]: (typeof AGENT_SPECS)[K]['binding'] extends null ? never : K;
}[AgentId];

/** Every known API format (runtime allowlist for validation). */
export const API_FORMATS: readonly ApiFormat[] = [
  'anthropic',
  'openai',
  'openai-responses',
  'gemini',
];

/**
 * Normalize an untrusted list of formats: drops unknown names and duplicates, and returns
 * the survivors in {@link API_FORMATS} order so the persisted value is canonical regardless
 * of how the caller (a checkbox group, a hand-edited file) ordered it. Fail-closed by
 * construction — an unrecognized name is discarded, never passed through.
 */
export function normalizeApiFormats(raw: readonly unknown[]): ApiFormat[] {
  const wanted = new Set(raw.filter((f): f is string => typeof f === 'string').map((f) => f.trim()));
  return API_FORMATS.filter((f) => wanted.has(f));
}

/** Every known agent id (runtime allowlist for validation) — derived from {@link AGENT_SPECS}. */
export const AGENT_IDS: readonly AgentId[] = Object.keys(AGENT_SPECS) as AgentId[];

export function isBindableAgentId(id: AgentId): id is BindableAgentId {
  return AGENT_SPECS[id].binding !== null;
}

/** Bindable agents in {@link AGENT_SPECS} table order. */
export const BINDABLE_AGENT_IDS: readonly BindableAgentId[] = AGENT_IDS.filter(isBindableAgentId);

/**
 * Canonical display name for every agent — derived from {@link AGENT_SPECS}, so the
 * binding registry (Providers) and the skills matrix can never drift. Covers all of
 * {@link AGENT_IDS}, including skills-only agents that are absent from {@link AGENTS}.
 */
export const AGENT_NAMES: Record<AgentId, string> = Object.fromEntries(
  (Object.entries(AGENT_SPECS) as [AgentId, AgentSpec][]).map(([id, spec]) => [id, spec.name]),
) as Record<AgentId, string>;

/**
 * A model a provider offers.
 * - `id` is the canonical/reference model identifier (the provider's real name).
 * - `alias` is an optional "outward" name written to the agent config instead of
 *   `id` — a short or agent-consistent name (e.g. a long model id shortened, or a
 *   gateway's custom name). When set and non-empty, everything written to the agent
 *   (its model catalog and its binding) uses `alias`; otherwise it uses `id`.
 *   See {@link wireModelName} and providerManager.setBinding.
 */
export interface ProviderModel {
  id: string;
  alias?: string;
  /** Friendly name from models.dev when matched (optional metadata, not secret). */
  catalogName?: string;
  /** Whether the catalog marks the model as a reasoning model (UI hint). */
  reasoning?: boolean;
}

/** The name written into an agent's config for a model: its alias when set, else its id. */
export function wireModelName(model: ProviderModel): string {
  return model.alias !== undefined && model.alias !== '' ? model.alias : model.id;
}

// --- upstream compatibility: droppable request fields ----------------------
//
// Some upstreams reject a request outright when it carries a field they do not know,
// instead of ignoring it. The classic case is a gateway (LiteLLM, OpenRouter, a vLLM
// deployment) in front of a backend that validates strictly: an OpenAI-shaped client
// sends `store`, the gateway forwards it to a Bedrock backend, and the whole call
// 400s on a field that never mattered.
//
// A SAME-FORMAT proxy route forwards the body unchanged, so there is nothing between
// the agent and that 400. `dropRequestFields` on a provider is the per-provider escape
// hatch: name the fields this upstream chokes on and the proxy strips them on the way
// out. It is deliberately per-provider, not global — "my gateway rejects `store`" is a
// property of one upstream, and a blanket switch would silently change the semantics of
// every other binding (see UNSUPPORTED_REQUEST_FIELDS in main/proxy/translate/types.ts,
// where refusing beats silently dropping).

/**
 * Request fields a provider may be configured to drop, grouped by what dropping COSTS.
 * The split exists because "strip a field" is not one action with one risk:
 *
 * - `safe` fields carry no model-visible semantics (bookkeeping, routing hints, an
 *   already-best-effort determinism knob). Dropping one changes nothing the caller can
 *   observe in the completion, so these are offered plainly.
 * - `sensitive` fields DO change what comes back. Dropping `response_format` turns a
 *   guaranteed-JSON contract into free prose, and the agent's parse failure will surface
 *   far from the cause; dropping `thinking`/`reasoning` silently downgrades the model.
 *   Still offered — an upstream that rejects them leaves no alternative — but the UI must
 *   warn, and nothing may enable them implicitly.
 *
 * `tools` / `tool_choice` / `messages` / `model` are absent on purpose and must never be
 * added: dropping a tool definition is a silent capability downgrade with no upper bound
 * on the damage, and the request is meaningless without the rest.
 */
export const DROPPABLE_REQUEST_FIELDS = {
  safe: ['store', 'user', 'metadata', 'seed', 'logit_bias', 'service_tier', 'prompt_cache_key'],
  sensitive: ['response_format', 'thinking', 'reasoning', 'reasoning_effort', 'n'],
} as const;

/** Every field a provider is allowed to drop — the validation allowlist. */
export const DROPPABLE_FIELD_NAMES: readonly string[] = [
  ...DROPPABLE_REQUEST_FIELDS.safe,
  ...DROPPABLE_REQUEST_FIELDS.sensitive,
];

/**
 * Normalize an untrusted list of field names against {@link DROPPABLE_FIELD_NAMES}:
 * trims, drops unknown names and duplicates, and returns them in allowlist order so the
 * persisted value is canonical regardless of how the caller ordered it. Fail-closed by
 * construction — an unrecognized name is discarded, never passed through to the strip
 * step, so a hand-edited providers.json cannot make the proxy strip `tools`.
 */
export function normalizeDropFields(raw: readonly string[]): string[] {
  const wanted = new Set(raw.map((f) => f.trim()).filter((f) => f !== ''));
  return DROPPABLE_FIELD_NAMES.filter((f) => wanted.has(f));
}

/**
 * A provider in the global pool. The API key is deliberately absent — it is stored
 * encrypted in the main-only secret store under `main_provider_<id>_key` and never
 * appears in this record (which is persisted as plaintext JSON and crosses IPC).
 *
 * OAuth providers (`credentialMode: 'oauth'`) store tokens under `main_oauth_provider_<id>`
 * instead; see docs/dev-rules/oauth-providers.md.
 */
export interface Provider {
  id: string;
  name: string;
  /** Defaults to API key when absent. */
  credentialMode?: ProviderCredentialMode;
  /** Public OAuth metadata when `credentialMode` is `oauth`. */
  oauth?: OAuthProviderConfig;
  /** Which agent session to read when `credentialMode` is `agent_import`. */
  agentImport?: AgentImportConfig;
  /**
   * The wire formats this provider serves at `baseUrl` — non-empty, de-duplicated, in
   * {@link API_FORMATS} order (see {@link normalizeApiFormats}). A gateway commonly serves
   * several (OpenAI Chat Completions + Responses, or Chat Completions + Anthropic
   * Messages); a binding picks the one the agent speaks natively when it can
   * (see {@link resolveBindingRoute}).
   */
  apiFormats: ApiFormat[];
  baseUrl: string;
  models: ProviderModel[];
  notes?: string;
  createdAt: number;
  /**
   * Request fields the proxy strips before forwarding to THIS upstream — the escape
   * hatch for a gateway that 400s on a field it does not recognize. Always a subset of
   * {@link DROPPABLE_FIELD_NAMES} (validated on every read and write). Absent/empty
   * means strip nothing, which is the default for every provider.
   */
  dropRequestFields?: string[];
}

/**
 * A built-in target agent. `acceptedFormats` gates which providers may bind;
 * `mode` is how its native config is rewritten — `exclusive` overwrites the active
 * provider, `additive` keeps all providers and only moves the default pointer.
 */
export interface AgentDef {
  id: AgentId;
  name: string;
  acceptedFormats: ApiFormat[];
  mode: 'exclusive' | 'additive';
}

/** Which provider+model an agent is currently pointed at. */
export interface AgentBinding {
  providerId: string;
  modelId: string;
}

/**
 * The BINDING registry: agents a pool provider can be bound to — DERIVED from
 * {@link AGENT_SPECS} as exactly those with a non-null `binding`, in table order.
 *
 * This is a subset of {@link AGENT_IDS}: `cursor` is intentionally absent because the Cursor
 * CLI has no bring-your-own-endpoint surface to bind a provider into (see {@link AgentSpec}).
 * Skills enumerates {@link AGENT_IDS} instead, so a skills-only agent still shows up there.
 */
export const AGENTS: readonly AgentDef[] = (Object.entries(AGENT_SPECS) as [AgentId, AgentSpec][])
  .filter(([, spec]) => spec.binding !== null)
  .map(([id, spec]) => ({
    id,
    name: spec.name,
    // Copy so a caller can never mutate the shared spec's readonly array in place.
    acceptedFormats: [...spec.binding!.acceptedFormats],
    mode: spec.binding!.mode,
  }));

/** Look up an agent definition by id. */
export function getAgentDef(id: AgentId): AgentDef | undefined {
  return AGENTS.find((a) => a.id === id);
}

/** A provider may bind to an agent natively when the two declare a shared format. */
export function isFormatCompatible(agent: AgentDef, provider: Provider): boolean {
  return provider.apiFormats.some((f) => agent.acceptedFormats.includes(f));
}

/**
 * How a provider can be pointed at an agent. This is the predicate both the binding
 * picker and `providerManager.applyBinding` use, so the UI cannot offer a pairing the
 * main process will refuse (or hide one it would accept).
 *
 * - `native` — the agent and the provider share a format, so the agent speaks it as-is.
 *   Proxy mode may still route it through the loopback (identity passthrough), but the
 *   pairing itself does not depend on translation.
 * - `translated` — no shared format, but the translation proxy can carry the agent's
 *   first accepted format to one the provider serves. Such a binding always goes through
 *   the proxy, whether or not proxy mode is on.
 * - `unsupported` — no shared format and no translation route (gemini crossed with any
 *   other format, or a cross-format pair whose only outbound is `openai-responses`).
 */
export type BindingAvailability = 'native' | 'translated' | 'unsupported';

/** The directed format pair a binding will use, and how it got there. */
export interface BindingRoute {
  kind: 'native' | 'translated';
  /** The format the agent speaks (its side of the wire). */
  inbound: ApiFormat;
  /** The format the provider is called with (the proxy's outbound, or the direct wire). */
  outbound: ApiFormat;
}

/**
 * Resolve which format pair a binding between `agent` and a provider serving
 * `providerFormats` will use, or null when no route exists.
 *
 * Preference order, deliberately from the AGENT's side: walk `acceptedFormats` in the
 * agent's declared order (its first entry is its primary dialect) and take the first the
 * provider also serves — a native match. Only when there is none does the route fall back
 * to translation, from the agent's first format into the first provider format
 * {@link translationSupported} accepts, tried in the order {@link TRANSLATION_TARGETS}
 * lists (the most faithful target first). Provider order never decides: `apiFormats` is
 * canonical, not a preference.
 */
export function resolveBindingRoute(
  agent: { acceptedFormats: readonly ApiFormat[] },
  providerFormats: readonly ApiFormat[],
): BindingRoute | null {
  for (const format of agent.acceptedFormats) {
    if (providerFormats.includes(format)) return { kind: 'native', inbound: format, outbound: format };
  }
  const inbound = agent.acceptedFormats[0];
  if (inbound === undefined) return null;
  for (const outbound of TRANSLATION_TARGETS[inbound]) {
    if (providerFormats.includes(outbound) && translationSupported(inbound, outbound)) {
      return { kind: 'translated', inbound, outbound };
    }
  }
  return null;
}

export function bindingAvailability(
  agent: { acceptedFormats: readonly ApiFormat[] },
  providerFormats: readonly ApiFormat[],
): BindingAvailability {
  return resolveBindingRoute(agent, providerFormats)?.kind ?? 'unsupported';
}

/**
 * For each inbound (agent) format, the outbound (provider) formats translation may target,
 * most faithful first. Mirrors {@link translationSupported}'s cross-format cases: a
 * Responses client prefers Chat Completions (same vendor shape, no reasoning bridge) over
 * Anthropic. Gemini is never a translation endpoint on either side.
 */
export const TRANSLATION_TARGETS: Readonly<Record<ApiFormat, readonly ApiFormat[]>> = {
  anthropic: ['openai'],
  openai: ['anthropic'],
  'openai-responses': ['openai', 'anthropic'],
  gemini: [],
};

/**
 * Whether the loopback proxy can carry an `inbound` agent format to an `outbound`
 * provider format. `inbound` is the agent's format, `outbound` the provider's. This is
 * a pure predicate about the DIRECTED format pair only — it does not check whether an
 * adapter/route exists, nor whether proxy mode would route it (default is direct).
 *
 * Two kinds of routes qualify:
 *   - CROSS-format translation:
 *       - anthropic ⇄ openai (Chat Completions), both directions.
 *       - openai-responses (codex/grok) → openai (Chat Completions).
 *       - openai-responses (codex/grok) → anthropic (with a reasoning bridge).
 *   - SAME-format passthrough (identity transform, streamed through unchanged) so the
 *     proxy can still count token usage: anthropic→anthropic, openai→openai,
 *     openai-responses→openai-responses. This is what makes a same-format binding
 *     countable when proxy mode is on; the default (off) chooses a direct config instead.
 *
 * NOT supported: any CROSS-format direction whose OUTBOUND is `openai-responses` (no
 * need to emit the Responses API upstream — a Responses provider is reached by same-
 * format passthrough), and any pairing involving `gemini` (no proxy dialect for it —
 * gemini bindings are always direct, in either mode).
 */
export function translationSupported(inbound: ApiFormat, outbound: ApiFormat): boolean {
  if (inbound === 'gemini' || outbound === 'gemini') return false; // no gemini proxy dialect
  if (inbound === outbound) return true; // same-format passthrough (identity + usage sniff)
  if (outbound === 'openai-responses') return false; // never emit Responses upstream via translation
  switch (inbound) {
    case 'anthropic':
      return outbound === 'openai';
    case 'openai':
      return outbound === 'anthropic';
    case 'openai-responses':
      return outbound === 'openai' || outbound === 'anthropic';
    default:
      return false;
  }
}

// --- Built-in provider presets --------------------------------------------
//
// A small set of well-known providers AiOpt knows about. They are NOT seeded into
// the pool — the pool is entirely user-curated. Instead this list is the single
// factory source of truth for the "add provider" presets (see renderer presets.ts):
// picking one quick-fills a NEW custom provider (fresh id) the user then edits.
// Nothing in the pool ever carries this "official" identity or the prefix below.

/**
 * Reserved id prefix these presets use. The pool never contains an id with this
 * prefix (presets mint fresh UUIDs); the store drops any that appear, which also
 * migrates away providers seeded by older builds. Kept here as the single definition.
 */
export const OFFICIAL_PROVIDER_ID_PREFIX = 'official-';

/** The factory config behind one add-provider preset (name + endpoint + models). */
export interface OfficialProviderDef {
  id: string;
  name: string;
  apiFormats: ApiFormat[];
  baseUrl: string;
  models: ProviderModel[];
}

/** The known providers offered as add-provider presets. Stable ids + endpoints/models. */
export const OFFICIAL_PROVIDERS: readonly OfficialProviderDef[] = [
  {
    id: 'official-anthropic',
    name: 'Anthropic',
    apiFormats: ['anthropic'],
    baseUrl: 'https://api.anthropic.com',
    models: [{ id: 'claude-opus-4-20250514' }, { id: 'claude-sonnet-4-20250514' }],
  },
  {
    id: 'official-openai',
    name: 'OpenAI',
    // The official API serves both OpenAI dialects at the same base.
    apiFormats: ['openai', 'openai-responses'],
    baseUrl: 'https://api.openai.com/v1',
    models: [{ id: 'gpt-4o' }, { id: 'o3' }],
  },
  {
    id: 'official-deepseek',
    name: 'DeepSeek',
    apiFormats: ['openai'],
    baseUrl: 'https://api.deepseek.com',
    models: [{ id: 'deepseek-chat' }],
  },
  {
    id: 'official-moonshot',
    name: 'Moonshot (Kimi)',
    apiFormats: ['anthropic'],
    baseUrl: 'https://api.moonshot.cn/anthropic',
    models: [{ id: 'kimi-k2-0711-preview' }],
    // NOTE: `/anthropic` is Moonshot's messages-only compat shim (what Claude binds
    // to); it serves no model catalog, so "Load models" won't work from this preset
    // base — the user edits the URL or enters models by hand. Verify against live docs.
  },
];
