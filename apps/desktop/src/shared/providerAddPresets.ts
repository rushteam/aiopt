// Add-provider form presets — API-key vendors and OAuth subscription templates.
//
// Add-provider presets: pick a vendor, paste a key or sign in. Subscription OAuth
// kinds carry fixed driver metadata when enabled; the form never asks for
// authorize/token URLs unless the user picks custom PKCE.

import type { ApiFormat, ProviderModel } from './aiProviders';
import { OFFICIAL_PROVIDERS } from './aiProviders';
import type { OAuthSubscriptionKind, ProviderCredentialMode } from './oauthProviders';

export interface AddProviderPreset {
  key: string;
  name: string;
  apiFormats: ApiFormat[];
  baseUrl: string;
  models: ProviderModel[];
  credentialMode: ProviderCredentialMode;
  /** Set when `credentialMode` is `oauth`. */
  oauthKind?: OAuthSubscriptionKind;
}

const API_PRESETS: AddProviderPreset[] = OFFICIAL_PROVIDERS.map((p) => ({
  key: p.id,
  name: p.name,
  apiFormats: [...p.apiFormats],
  baseUrl: p.baseUrl,
  models: p.models.map((m) => ({ ...m })),
  credentialMode: 'api_key' as const,
}));

/** Subscription OAuth templates (driver-owned endpoints; see oauth-providers.md). */
const OAUTH_PRESETS: AddProviderPreset[] = [
  {
    key: 'oauth-openai-codex',
    name: 'ChatGPT (Codex)',
    apiFormats: ['openai-responses'],
    baseUrl: 'https://api.openai.com/v1',
    models: [{ id: 'gpt-5' }],
    credentialMode: 'oauth',
    oauthKind: 'openai_codex',
  },
  {
    key: 'oauth-anthropic-claude',
    name: 'Claude (subscription)',
    apiFormats: ['anthropic'],
    baseUrl: 'https://api.anthropic.com',
    models: [{ id: 'claude-sonnet-4-20250514' }],
    credentialMode: 'oauth',
    oauthKind: 'anthropic_claude',
  },
  {
    key: 'oauth-github-copilot',
    name: 'GitHub Copilot',
    apiFormats: ['openai'],
    baseUrl: 'https://api.githubcopilot.com',
    models: [{ id: 'gpt-4o' }],
    credentialMode: 'oauth',
    oauthKind: 'github_copilot',
  },
  {
    key: 'oauth-huawei-codearts',
    name: 'CodeArts (Huawei)',
    apiFormats: ['openai'],
    baseUrl: 'https://snap-access.cn-north-4.myhuaweicloud.com/api/v2',
    models: [
      { id: 'GLM-5.2', catalogName: 'GLM-5.2' },
      { id: 'glm-5.3-flash', catalogName: 'GLM-5.3 Flash' },
      { id: 'deepseek-v4.1-flash', catalogName: 'DeepSeek V4.1 Flash' },
      { id: 'openpangu-2.0-pro', catalogName: 'openPangu 2.0 Pro' },
    ],
    credentialMode: 'oauth',
    oauthKind: 'huawei_codearts',
  },
  {
    key: 'oauth-generic-pkce',
    name: 'Custom OAuth',
    apiFormats: ['openai'],
    baseUrl: '',
    models: [{ id: 'gpt-4o' }],
    credentialMode: 'oauth',
    oauthKind: 'generic_pkce',
  },
];

export const ADD_PROVIDER_PRESETS: readonly AddProviderPreset[] = [...API_PRESETS, ...OAUTH_PRESETS];
