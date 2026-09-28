import { MAIN_ONLY_SECRET_PREFIX, type SecretStore } from '../secrets/secretStore';

export interface OAuthTokenBundle {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number | null;
}

export function oauthProviderSecretKey(providerId: string): string {
  return `${MAIN_ONLY_SECRET_PREFIX}oauth_provider_${providerId}`;
}

export function readOAuthTokens(secrets: SecretStore, providerId: string): OAuthTokenBundle | null {
  const raw = secrets.get(oauthProviderSecretKey(providerId));
  if (!raw) return null;
  try {
    const doc = JSON.parse(raw) as unknown;
    if (!doc || typeof doc !== 'object') return null;
    const o = doc as Record<string, unknown>;
    if (typeof o.accessToken !== 'string' || o.accessToken === '') return null;
    const bundle: OAuthTokenBundle = { accessToken: o.accessToken, expiresAt: null };
    if (typeof o.refreshToken === 'string' && o.refreshToken !== '') bundle.refreshToken = o.refreshToken;
    if (typeof o.expiresAt === 'number' && Number.isFinite(o.expiresAt)) bundle.expiresAt = o.expiresAt;
    return bundle;
  } catch {
    return null;
  }
}

export function writeOAuthTokens(secrets: SecretStore, providerId: string, bundle: OAuthTokenBundle): void {
  secrets.set(oauthProviderSecretKey(providerId), JSON.stringify(bundle));
}

export function clearOAuthTokens(secrets: SecretStore, providerId: string): void {
  secrets.delete(oauthProviderSecretKey(providerId));
}
