// Shared types + comparison for binding drift. Each agent adapter implements
// `readLiveBinding` using the same fields it writes in `writeLive` — there is no
// single on-disk schema across agents (JSON env vs TOML vs YAML vs multi-file).

import fs from 'node:fs';
import { isMap, isScalar, isSeq, parseDocument, type YAMLMap } from 'yaml';
import type { AppliedBindingRecord } from '../bindingAppliedStore';
import { tomlString } from '../tomlLite';

export interface LiveBindingSnapshot {
  baseUrl: string;
  modelId: string;
  authTokenSet: boolean;
  /** When false, model id is not persisted on disk for this agent (e.g. dsh). */
  compareModel?: boolean;
}

export function normalizeBindingUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/** True when disk no longer matches the last applied snapshot. */
export function bindingDriftDetected(
  applied: AppliedBindingRecord,
  live: LiveBindingSnapshot | null,
): boolean {
  if (!live) return true;
  if (normalizeBindingUrl(live.baseUrl) !== normalizeBindingUrl(applied.baseUrl)) return true;
  const compareModel = live.compareModel !== false;
  if (compareModel && live.modelId.trim() !== applied.modelId.trim()) return true;
  if (live.authTokenSet !== applied.authTokenSet) return true;
  return false;
}

export function aioptProviderSlug(applied: AppliedBindingRecord): string | null {
  return applied.providerId ? `aiopt-${applied.providerId}` : null;
}

/**
 * Whether `key` is an entry AiOpt wrote for some OTHER provider. Multi-provider configs keep one
 * `aiopt-<providerId>` entry per provider ever bound, and a binding switch only upserts the new
 * one — so without pruning, the agent's own model picker keeps offering dead entries (a loopback
 * URL whose per-binding token is revoked, a deleted provider) and stale keys stay on disk. Only
 * the `aiopt-` namespace is touched; the user's own entries never match.
 */
export function isStaleAioptKey(key: unknown, keep: string): boolean {
  return typeof key === 'string' && key.startsWith('aiopt-') && key !== keep;
}

/** Drop every other-provider `aiopt-*` key from a plain JSON object, in place. */
export function pruneAioptKeys(obj: Record<string, unknown>, keep: string): void {
  for (const key of Object.keys(obj)) if (isStaleAioptKey(key, keep)) delete obj[key];
}

/** YAML counterpart of {@link pruneAioptKeys}, for a map node (comments elsewhere survive). */
export function pruneAioptYamlKeys(map: unknown, keep: string, isStale = isStaleAioptKey): void {
  if (!isMap(map)) return;
  const node = map as YAMLMap;
  node.items = node.items.filter((pair) => {
    const key = isScalar(pair.key) ? pair.key.value : pair.key;
    return !isStale(key, keep);
  });
}

/** Drop other-provider entries from a YAML sequence of maps keyed by `name` (Hermes). */
export function pruneAioptYamlSeqByName(seq: unknown, keep: string): void {
  if (!isSeq(seq)) return;
  seq.items = seq.items.filter((item) => !(isMap(item) && isStaleAioptKey(item.get('name'), keep)));
}

/** dsh credential refs AiOpt wrote (`AIOPT_<ID>_KEY`), other than `keep`. */
export function isStaleDshCredentialRef(key: unknown, keep: string): boolean {
  return typeof key === 'string' && /^AIOPT_[A-Z0-9_]+_KEY$/.test(key) && key !== keep;
}

export function readTomlScalar(text: string, key: string): string | null {
  const re = new RegExp(`^\\s*${key}\\s*=\\s*["']?([^"'\\n#]+)`, 'm');
  const m = text.match(re);
  if (!m) return null;
  return m[1]?.trim().replace(/^["']|["']$/g, '') ?? null;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Read scalar keys from a TOML table until the next `[` header. */
export function readTomlTable(text: string, tablePattern: RegExp): Record<string, string> {
  const m = text.match(tablePattern);
  if (!m || m.index === undefined) return {};
  const start = m.index + m[0].length;
  const rest = text.slice(start);
  const end = rest.search(/^\s*\[/m);
  const body = end === -1 ? rest : rest.slice(0, end);
  const out: Record<string, string> = {};
  for (const line of body.split('\n')) {
    const kv = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/);
    if (!kv?.[1] || !kv[2]) continue;
    const raw = kv[2].trim();
    out[kv[1]] = raw.replace(/^["']|["']$/g, '');
  }
  return out;
}

export function readEnvFileVars(file: string): Record<string, string> {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

export function readYamlConfigDocument(file: string): ReturnType<typeof parseDocument> {
  try {
    return parseDocument(fs.readFileSync(file, 'utf-8'));
  } catch {
    return parseDocument('');
  }
}

export function grokModelTableHeader(modelId: string): string {
  return `[model.${tomlString(modelId)}]`;
}

export function dshCredentialRefName(providerId: string): string {
  return `AIOPT_${providerId.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}_KEY`;
}
