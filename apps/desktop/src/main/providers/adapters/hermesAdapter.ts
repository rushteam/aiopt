// Hermes adapter (additive).
//
// Hermes (Nous Research, `NousResearch/hermes-agent`) reads a single YAML file,
// `~/.hermes/config.yaml`. Unlike the JSON/TOML agents, this is a MERGE target we edit
// through yaml's document API so the user's comments, unrelated sections (`agent`,
// `mcp_servers`, `memory`, …) and any Hermes-only fields survive untouched.
//
// It holds a list of coexisting providers under `custom_providers:`; we upsert only our
// own entry, matched by a namespaced `name` slug `aiopt-<providerId>` so it can never
// collide with a provider the user (or Hermes) added. We also move the startup pointer
// (`model.default` + `model.provider`) onto our binding, mirroring how Hermes itself
// switches the active provider.
//
// Hermes selects its wire protocol per provider via `api_mode`; API_MODE_BY_FORMAT maps
// our provider's apiFormat onto it. The compatibility gate (AGENTS.acceptedFormats) only
// routes openai / anthropic / openai-responses providers here.
//
// NOTE: Hermes v12+ also exposes a read-only `providers:` MAP that its own Web UI owns.
// We never touch it — we only ever write the `custom_providers:` LIST, exactly as
// cc-switch does, leaving `providers:` entries to Hermes.

import fs from 'node:fs';
import { parseDocument, isSeq, isMap, type Document, type YAMLMap, type YAMLSeq } from 'yaml';
import type { AgentAdapter, WriteLiveInput } from './agentAdapter';
import { getAgentDef, wireModelName, type AgentDef, type ApiFormat } from '../../../shared/aiProviders';
import { AGENT_FILES, agentConfigDir, resolveAgentFile } from '../agentPaths';
import { restoreAgentConfigFile, writeAgentConfigFile } from '../fsutil';

const HERMES_DEF: AgentDef = getAgentDef('hermes')!;

/** apiFormat → Hermes `api_mode` (its per-provider wire-protocol selector). */
const API_MODE_BY_FORMAT: Record<ApiFormat, string> = {
  openai: 'chat_completions',
  'openai-responses': 'codex_responses',
  anthropic: 'anthropic_messages',
  // gemini is not an accepted Hermes format (see AGENTS.acceptedFormats), so this is
  // never reached; kept for type-completeness, treated as the OpenAI-shaped default.
  gemini: 'chat_completions',
};

/**
 * Parse `~/.hermes/config.yaml` into an editable document, preserving comments and
 * layout. Fail-open like fsutil.readJsonObject: a missing OR unparseable file starts
 * from an empty document (the pristine original is still backed up before we overwrite).
 */
function readConfigDocument(file: string): Document.Parsed {
  try {
    return parseDocument(fs.readFileSync(file, 'utf-8'));
  } catch {
    return parseDocument('');
  }
}

/** The `custom_providers` sequence, creating (and attaching) an empty one if absent/corrupt. */
function customProvidersSeq(doc: Document.Parsed): YAMLSeq {
  const existing = doc.get('custom_providers');
  if (isSeq(existing)) return existing;
  doc.set('custom_providers', []);
  return doc.get('custom_providers') as YAMLSeq;
}

/** Find our own provider entry (matched by the namespaced slug) within the sequence. */
function findEntryBySlug(seq: YAMLSeq, slug: string): YAMLMap | undefined {
  for (const item of seq.items) {
    if (isMap(item) && item.get('name') === slug) return item;
  }
  return undefined;
}

export function createHermesAdapter(): AgentAdapter {
  return {
    def: HERMES_DEF,

    configPaths() {
      return [resolveAgentFile(AGENT_FILES.hermes.config)];
    },

    detectInstalled() {
      return fs.existsSync(agentConfigDir('hermes'));
    },

    writeLive({ provider, modelId, apiKey }: WriteLiveInput) {
      const file = resolveAgentFile(AGENT_FILES.hermes.config);
      const doc = readConfigDocument(file);
      const slug = `aiopt-${provider.id}`;

      // Each model listed by its outward wire name (alias when set, else id) so the
      // singular `model` pointer — also the wire name — always resolves to an entry.
      const models: Record<string, Record<string, never>> = {};
      for (const model of provider.models) models[wireModelName(model)] = {};

      // Upsert our entry, preserving any Hermes-only fields already on it.
      const seq = customProvidersSeq(doc);
      let entry = findEntryBySlug(seq, slug);
      if (!entry) {
        // createNode yields a real YAMLMap (a plain object added to the seq would not be
        // one, so a later isMap()-based lookup could not find it back).
        entry = doc.createNode({ name: slug }) as YAMLMap;
        seq.add(entry);
      }
      entry.set('base_url', provider.baseUrl);
      entry.set('api_mode', API_MODE_BY_FORMAT[provider.apiFormat]);
      entry.set('model', modelId);
      entry.set('models', models);
      if (apiKey) entry.set('api_key', apiKey);
      else entry.delete('api_key');

      // Move Hermes's startup pointer onto our binding (mirrors its own provider switch).
      doc.setIn(['model', 'default'], modelId);
      doc.setIn(['model', 'provider'], slug);

      writeAgentConfigFile(file, doc.toString());
    },

    restoreDefault() {
      for (const file of this.configPaths()) restoreAgentConfigFile(file);
    },
  };
}
