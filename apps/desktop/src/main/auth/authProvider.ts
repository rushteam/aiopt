// Auth provider — the backend seam.
//
// A provider knows how to turn credentials into a session and how to validate /
// revoke a session token. It is DELIBERATELY stateless and persistence-free: the
// authManager owns the state machine and stores the token in the OS secret store.
// A real app swaps in a provider that talks to its backend; the framework ships a
// local stub (localStubAuthProvider.ts). See
// docs/dev-rules/credentials-and-local-storage.md.

import type { AuthUser } from '../../shared/ipc-channels';

/** Credentials collected by the renderer and passed through to the provider. */
export interface AuthCredentials {
  username: string;
  password: string;
}

/**
 * A successful authentication. The `token` is the SECRET (persisted by the
 * manager into the secret store, never surfaced to the renderer); `user` is the
 * safe identity that may appear in the UI.
 */
export interface AuthSession {
  user: AuthUser;
  token: string;
}

export interface AuthProvider {
  /**
   * Exchange credentials for a session. Throw an IPC-coded error
   * (PERMISSION_DENIED for bad credentials) on failure.
   */
  authenticate(credentials: AuthCredentials): Promise<AuthSession>;

  /**
   * Validate a previously-persisted token on startup and return the identity it
   * belongs to, or `null` if it is no longer valid. Never throws for an ordinary
   * expired/invalid token — that is a `null`, not an error.
   */
  restore(token: string): Promise<AuthUser | null>;

  /** Best-effort revoke of a token on logout. Failures are swallowed by the manager. */
  revoke(token: string): Promise<void>;
}
