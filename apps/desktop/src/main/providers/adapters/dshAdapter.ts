// dsh adapter (additive).
//
// dsh (DeepSeek Harness, `@deepseek-ai/dsh`) is a Cordis/Koishi-style app that splits
// provider config across TWO YAML files under `~/.dsh` (honouring `$DSH_HOME`):
//
//   - settings.yaml       — non-secret provider settings. Its `llm-pi-ai.providers` is a
//     DICT keyed by provider id (an array is rejected), so base and user layers merge per
//     provider. We upsert ONLY our own namespaced key (`aiopt-<providerId>`) and preserve
//     every other provider, unrelated namespaces, comments, and any dsh-only fields on our
//     own entry. The API key is NOT stored here — the entry carries `apiKeyEnv`, the NAME
//     of a credential reference that points into the credentials file below.
//   - .credentials.yaml   — the secret. A versioned store (`version: 1`) whose `refs` map
//     is keyed by the credential-reference name; `refs.<name>` holds the literal key. dsh
//     REJECTS this file at load if it is group/other-readable, so it MUST be written 0600
//     (writeAgentConfigFile's `mode` arg; the containing dir is forced to 0700).
//
// dsh selects its wire protocol per provider via the `api` field; API_BY_FORMAT maps our
// provider's apiFormat onto it. The compatibility gate (AGENTS.acceptedFormats) only routes
// openai / openai-responses / anthropic providers here.
//
// NOTE: dsh's active model/provider selection is per-thread runtime state, not a settings.yaml
// field, so — unlike Hermes — there is no startup pointer to move here. Declaring the provider
// (with its base URL, protocol, credential ref, and model list) is what makes the binding
// available for dsh to use; the user picks the model in dsh's own UI.

import fs from 'node:fs';
import { parseDocument, isMap, type Document, type YAMLMap } from 'yaml';
import type { AgentAdapter, WriteLiveInput } from './agentAdapter';
import { getAgentDef, wireModelName, type AgentDef, type ApiFormat } from '../../../shared/aiProviders';
import { AGENT_FILES, agentConfigDir, resolveAgentFile } from '../agentPaths';
import { restoreAgentConfigFile, writeAgentConfigFile } from '../fsutil';

const DSH_DEF: AgentDef = getAgentDef('dsh')!;

/** Owner-only mode dsh requires on `.credentials.yaml` (rejected at load otherwise). */
const CREDENTIALS_MODE = 0o600;

/** apiFormat → dsh's per-provider `api` (its wire-protocol selector, via llm-pi-ai). */
const API_BY_FORMAT: Record<ApiFormat, string> = {
  openai: 'openai-completions',
  'openai-responses': 'openai-responses',
  anthropic: 'anthropic-messages',
  // gemini is not an accepted dsh format (see AGENTS.acceptedFormats), so this is never
  // reached; kept for type-completeness, treated as the OpenAI-shaped default.
  gemini: 'openai-completions',
};

/**
 * A POSIX-identifier credential-reference name for a provider. dsh rejects ref names that
 * aren't identifiers (a UUID's hyphens would fail), so we uppercase, replace every
 * non-alphanumeric with `_`, and bracket it with a fixed prefix/suffix — the `AIOPT_`
 * prefix also guarantees a leading letter regardless of the provider id.
 */
function envRefName(providerId: string): string {
  return `AIOPT_${providerId.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}_KEY`;
}

/**
 * Parse a dsh YAML file into an editable document, preserving comments and layout.
 * Fail-open like fsutil.readJsonObject: a missing OR unparseable file starts from an
 * empty document (the pristine original is still backed up before we overwrite).
 */
function readConfigDocument(file: string): Document.Parsed {
  try {
    return parseDocument(fs.readFileSync(file, 'utf-8'));
  } catch {
    return parseDocument('');
  }
}

/** Get (or create and attach) the map at `path`, so siblings/comments there survive. */
function mapAt(doc: Document.Parsed, path: (string | number)[]): YAMLMap {
  const existing = doc.getIn(path);
  if (isMap(existing)) return existing;
  // createNode yields a real YAMLMap (a plain object set via setIn would not be one, so a
  // later `.set()` on the returned value would fail) — mirrors the Hermes adapter.
  const created = doc.createNode({}) as YAMLMap;
  doc.setIn(path, created);
  return created;
}

export function createDshAdapter(): AgentAdapter {
  return {
    def: DSH_DEF,

    configPaths() {
      return [resolveAgentFile(AGENT_FILES.dsh.settings), resolveAgentFile(AGENT_FILES.dsh.credentials)];
    },

    detectInstalled() {
      return fs.existsSync(agentConfigDir('dsh'));
    },

    writeLive({ provider, modelId, apiKey }: WriteLiveInput) {
      const slug = `aiopt-${provider.id}`;
      const credRef = envRefName(provider.id);

      // --- settings.yaml: upsert our provider under llm-pi-ai.providers.<slug> ---
      const settingsFile = resolveAgentFile(AGENT_FILES.dsh.settings);
      const settings = readConfigDocument(settingsFile);
      const entry = mapAt(settings, ['llm-pi-ai', 'providers', slug]);
      entry.set('displayName', provider.name);
      entry.set('api', API_BY_FORMAT[provider.apiFormat]);
      entry.set('baseURL', provider.baseUrl);
      // Each model listed by its outward wire name (alias when set, else id) — this is the
      // id dsh sends on the wire.
      entry.set('models', provider.models.map((model) => ({ id: wireModelName(model) })));
      if (apiKey) entry.set('apiKeyEnv', credRef);
      else entry.delete('apiKeyEnv'); // no key → no dangling reference into credentials
      writeAgentConfigFile(settingsFile, settings.toString());

      // --- .credentials.yaml: store the secret under refs.<credRef> (0600) ---
      const credFile = resolveAgentFile(AGENT_FILES.dsh.credentials);
      const creds = readConfigDocument(credFile);
      creds.set('version', 1); // required; a file with entries but no version is rejected
      const refs = mapAt(creds, ['refs']);
      if (apiKey) refs.set(credRef, apiKey);
      else refs.delete(credRef);
      writeAgentConfigFile(credFile, creds.toString(), CREDENTIALS_MODE);
    },

    restoreDefault() {
      for (const file of this.configPaths()) restoreAgentConfigFile(file);
    },
  };
}
