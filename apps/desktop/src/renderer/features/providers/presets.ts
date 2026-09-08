// Quick-fill presets for the "add provider" form.
//
// These are just starting points (name + format + baseUrl + common models) the
// user can edit before saving; the API key is always entered by hand. Purely a
// renderer convenience — the pool's source of truth is still the main-side store.
//
// They are DERIVED from the shared OFFICIAL_PROVIDERS factory list so the shipped
// endpoints/models live in exactly one place. A preset only seeds a NEW (custom)
// provider with a fresh id; it carries no official identity of its own.

import { OFFICIAL_PROVIDERS } from '../../../shared/aiProviders';
import type { ApiFormat, ProviderModel } from '../../../shared/aiProviders';

export interface ProviderPreset {
  key: string;
  name: string;
  apiFormat: ApiFormat;
  baseUrl: string;
  models: ProviderModel[];
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = OFFICIAL_PROVIDERS.map((p) => ({
  key: p.id,
  name: p.name,
  apiFormat: p.apiFormat,
  baseUrl: p.baseUrl,
  models: p.models.map((m) => ({ ...m })),
}));
