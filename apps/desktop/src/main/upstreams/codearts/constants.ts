// CodeArts (Huawei 码道) SnapEngine endpoints and OAuth constants.
//
// Fixed to cn-north-4 for MVP — same region the desktop agent and community
// references use. Not loaded at runtime; compiled into the main bundle.

export const CODEARTS_CHAT_BASE = 'https://snap-access.cn-north-4.myhuaweicloud.com/api/v2';
export const CODEARTS_SNAP_HOST = 'https://snap-access.cn-north-4.myhuaweicloud.com';
export const CODEARTS_MODEL_BUILTIN_URL = `${CODEARTS_SNAP_HOST}/v1/model/builtin`;
export const CODEARTS_OPENGW_GATEWAY_CONFIG_URL =
  'https://opengw.developer.huaweicloud.com/api/v1/gateway/config';

export const CODEARTS_PORTAL_AUTHORIZE = 'https://codearts.huaweicloud.com/portal/authorize';
export const CODEARTS_PORTAL_LOGIN = 'https://codearts.huaweicloud.com/portal/login';
export const CODEARTS_STS_TOKEN_URL = 'https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens';

/** Matches the desktop agent's product.json `auth.clientId`. */
export const CODEARTS_CLIENT_ID = 'codearts';
export const CODEARTS_REDIRECT_PATH = '/oauth/callback';
export const CODEARTS_PLUGIN_NAME = 'snap_AIIDE';
export const CODEARTS_PLUGIN_VERSION = '5.1.0';

/** Portal asks for a listening port at or above this. */
export const CODEARTS_MIN_CALLBACK_PORT = 10_000;

export const CODEARTS_TOKEN_TIMEOUT_MS = 60_000;
export const CODEARTS_OAUTH_TIMEOUT_MS = 180_000;
/** Renew temporary STS credentials this long before expiry. */
export const CODEARTS_REFRESH_LEAD_MS = 30 * 60 * 1000;

/** Free-quota / benefit models need a signed `maas_type: benefit` header. */
export const CODEARTS_BENEFIT_MODEL_FALLBACK = ['glm-5.3-flash', 'deepseek-v4.1-flash'] as const;

export const CODEARTS_FALLBACK_MODELS = [
  { id: 'GLM-5.2', catalogName: 'GLM-5.2' },
  { id: 'GLM-5.1', catalogName: 'GLM-5.1' },
  { id: 'glm-5.3-flash', catalogName: 'GLM-5.3 Flash' },
  { id: 'deepseek-v4-flash', catalogName: 'DeepSeek V4 Flash' },
  { id: 'deepseek-v4-pro', catalogName: 'DeepSeek V4 Pro' },
  { id: 'deepseek-v4.1-flash', catalogName: 'DeepSeek V4.1 Flash' },
  { id: 'openpangu-2.0-flash', catalogName: 'openPangu 2.0 Flash' },
  { id: 'openpangu-2.0-pro', catalogName: 'openPangu 2.0 Pro' },
] as const;
