// Shared types + comparison for binding drift. Each agent adapter implements
// `readLiveBinding` using the same fields it writes in `writeLive` — there is no
// single on-disk schema across agents (JSON env vs TOML vs YAML vs multi-file).

import fs from 'node:fs';
import { parseDocument } from 'yaml';
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
