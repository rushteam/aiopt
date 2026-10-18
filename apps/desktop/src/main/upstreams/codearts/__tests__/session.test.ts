import { describe, expect, it } from 'vitest';
import {
  parseCodeArtsSession,
  serializeCodeArtsSession,
  sessionFromTokenResponse,
} from '../session';

const jwk = {
  kty: 'EC' as const,
  crv: 'P-256' as const,
  x: 'x',
  y: 'y',
  d: 'd',
};

describe('codearts session', () => {
  it('round-trips through serialize/parse', () => {
    const session = {
      accessKeyId: 'ak',
      secretAccessKey: 'sk',
      securityToken: 'st',
      expiresAt: '2030-01-01T00:00:00Z',
      refreshToken: 'rt',
      codeVerifier: 'cv',
      dpopPrivateKeyJwk: jwk,
      userName: 'alice',
    };
    const again = parseCodeArtsSession(serializeCodeArtsSession(session));
    expect(again).toEqual(session);
  });

  it('rejects incomplete or non-JSON access payloads', () => {
    expect(parseCodeArtsSession('')).toBeNull();
    expect(parseCodeArtsSession('{')).toBeNull();
    expect(parseCodeArtsSession(JSON.stringify({ accessKeyId: 'ak' }))).toBeNull();
  });

  it('builds a session from an STS token response', () => {
    const session = sessionFromTokenResponse(
      {
        refresh_token: 'rt',
        credentials: {
          access_key_id: 'ak',
          secret_access_key: 'sk',
          security_token: 'st',
          expiration: '2030-01-01T00:00:00Z',
        },
      },
      'cv',
      jwk,
    );
    expect(session).toMatchObject({
      accessKeyId: 'ak',
      secretAccessKey: 'sk',
      securityToken: 'st',
      refreshToken: 'rt',
      codeVerifier: 'cv',
      expiresAt: '2030-01-01T00:00:00Z',
    });
  });
});
