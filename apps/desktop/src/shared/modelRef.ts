// Unified `provider/model` naming — shared by Providers UI and Workbench labels.
//
// Pure helpers only. The "combined provider" aggregates every pool entry into one picker;
// its staged model ids encode `{ providerId, modelId }` with a separator that cannot
// appear in a UUID (see {@link encodeCombinedModelKey}).

import type { ProviderModel } from './aiProviders';
import { wireModelName } from './aiProviders';

/** Virtual pool entry id — never persisted in providers.json. */
export const COMBINED_PROVIDER_ID = '__aiopt_combined__';

/** Separates provider id from model id inside a combined-provider model row. */
export const COMBINED_MODEL_SEP = '\u241f';

/** Slug used in `provider/model` refs (display); derived from the provider's display name. */
export function providerSlug(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]+/g, '')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return slug !== '' ? slug : 'provider';
}

/** Canonical display ref: `deepseek/deepseek-chat` (uses wire name / alias when set). */
export function formatModelRef(providerName: string, model: ProviderModel | string): string {
  const wire = typeof model === 'string' ? model : wireModelName(model);
  return `${providerSlug(providerName)}/${wire}`;
}

/** Parse a display ref; returns null when there is no `/` segment. */
export function parseModelRef(ref: string): { slug: string; modelWire: string } | null {
  const i = ref.indexOf('/');
  if (i <= 0 || i >= ref.length - 1) return null;
  return { slug: ref.slice(0, i), modelWire: ref.slice(i + 1) };
}

export function encodeCombinedModelKey(providerId: string, modelId: string): string {
  return `${providerId}${COMBINED_MODEL_SEP}${modelId}`;
}

export function decodeCombinedModelKey(key: string): { providerId: string; modelId: string } | null {
  const i = key.indexOf(COMBINED_MODEL_SEP);
  if (i <= 0 || i >= key.length - 1) return null;
  return { providerId: key.slice(0, i), modelId: key.slice(i + 1) };
}
