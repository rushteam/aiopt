// Agent adapter seam — how a bound provider is written into one agent's native config.
//
// Each agent has quirks (file format, single vs. multi-file, env vs. structured,
// exclusive vs. additive), so the manager stays agent-agnostic and delegates the
// last mile to an adapter. `writeLive` receives the resolved provider, the chosen
// model, and the plaintext API key (read main-side at apply time — agents read
// plaintext, so this is unavoidable) and must go through fsutil's guarded write.

import type { AgentDef, ApiFormat, Provider } from '../../../shared/aiProviders';

/** The inputs an adapter needs to render + persist a live binding. */
export interface WriteLiveInput {
  provider: Provider;
  /**
   * The wire format the agent must speak at `provider.baseUrl` — the one format the
   * manager resolved for THIS binding (see resolveBindingRoute), not the provider's whole
   * `apiFormats` list. For a direct binding it is the shared native format; for a proxied
   * one it is the loopback's inbound dialect. Adapters with a per-provider protocol
   * selector (hermes `api_mode`, dsh/pi `api`, opencode `npm`) map from this.
   */
  apiFormat: ApiFormat;
  /** The model name to write into the agent config: a model's `alias` if set, else its `id`. */
  modelId: string;
  /** Plaintext key, or null if the provider has none stored. */
  apiKey: string | null;
}

export interface AgentAdapter {
  readonly def: AgentDef;
  /** Absolute config files this adapter owns (all allowlisted). */
  configPaths(): string[];
  /** Whether the agent appears installed (its config dir exists). */
  detectInstalled(): boolean;
  /** Render the provider into the agent's native format and write it (backup + atomic). */
  writeLive(input: WriteLiveInput): void;
  /**
   * Undo AiOpt's takeover: restore every config file this adapter owns to its
   * pre-AiOpt state (backup written back, or the AiOpt-created file removed). See
   * `restoreAgentConfigFile`.
   */
  restoreDefault(): void;
}
