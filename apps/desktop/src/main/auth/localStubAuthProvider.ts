// Local stub auth provider — the batteries-included default.
//
// It accepts any non-empty credentials (the IPC layer already enforces non-empty
// strings) and mints a stub token that encodes the username so a restart can
// restore the same identity. There is NO real backend and NO real secret here —
// the token is a marker, not a credential. Replace this provider with one that
// talks to your backend; the manager and IPC surface stay unchanged.

import type { AuthUser } from '../../shared/ipc-channels';
import type { AuthCredentials, AuthProvider, AuthSession } from './authProvider';

const STUB_TOKEN_PREFIX = 'stub.';

function userFrom(username: string): AuthUser {
  return { id: `local:${username}`, displayName: username };
}

/** Encode the username into the stub token (base64url — not encryption, just transport). */
function mintStubToken(username: string): string {
  return STUB_TOKEN_PREFIX + Buffer.from(username, 'utf8').toString('base64url');
}

export function createLocalStubAuthProvider(): AuthProvider {
  return {
    async authenticate({ username }: AuthCredentials): Promise<AuthSession> {
      // The stub trusts any credentials that passed IPC validation.
      return { user: userFrom(username), token: mintStubToken(username) };
    },

    async restore(token: string): Promise<AuthUser | null> {
      if (!token.startsWith(STUB_TOKEN_PREFIX)) return null;
      try {
        const username = Buffer.from(token.slice(STUB_TOKEN_PREFIX.length), 'base64url').toString(
          'utf8',
        );
        return username ? userFrom(username) : null;
      } catch {
        return null;
      }
    },

    async revoke(): Promise<void> {
      // Nothing to revoke for the stub.
    },
  };
}
