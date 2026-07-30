// Auth manager — the state machine that sits between the provider and IPC.
//
// It owns the single source of truth for session state and is the ONLY place the
// session token is persisted: writes go to the OS secret store under a main-only
// key, so the token never reaches a git-tracked path and never crosses IPC to the
// renderer. Every transition (login / logout / startup restore) notifies via the
// injected `onStateChange`, which the wiring turns into a broadcast to all
// windows. See docs/dev-rules/credentials-and-local-storage.md.

import type { AuthState, AuthStatus, AuthUser } from '../../shared/ipc-channels';
import type { SecretStore } from '../secrets/secretStore';
import { MAIN_ONLY_SECRET_PREFIX } from '../secrets/secretStore';
import type { AuthCredentials, AuthProvider } from './authProvider';

/**
 * Secret-store key for the session token. The `main_` prefix marks it main-only,
 * so the renderer-facing secret IPC refuses it (and there is no plaintext-read
 * channel regardless).
 */
export const AUTH_TOKEN_KEY = `${MAIN_ONLY_SECRET_PREFIX}auth_token`;

const SIGNED_OUT: AuthState = { status: 'signed-out', user: null };

export interface AuthManager {
  /** The current safe state (never carries a token). */
  getState(): AuthState;
  /** Restore any persisted session on startup; returns (and broadcasts) the state. */
  initialize(): Promise<AuthState>;
  /** Exchange credentials for a session, persist the token, go signed-in. */
  login(credentials: AuthCredentials): Promise<AuthState>;
  /** Revoke + clear the token, go signed-out. */
  logout(): Promise<AuthState>;
}

/** Notified after every state transition (wired to a renderer broadcast). */
export type AuthStateListener = (state: AuthState) => void;

export function createAuthManager(
  provider: AuthProvider,
  secrets: SecretStore,
  onStateChange: AuthStateListener,
): AuthManager {
  let state: AuthState = SIGNED_OUT;

  function transition(status: AuthStatus, user: AuthUser | null): AuthState {
    state = { status, user };
    onStateChange(state);
    return state;
  }

  return {
    getState: () => state,

    async initialize() {
      const token = secrets.get(AUTH_TOKEN_KEY);
      if (!token) return state; // already signed-out
      const user = await provider.restore(token);
      if (!user) {
        // Stale/invalid token — drop it and stay signed-out.
        secrets.delete(AUTH_TOKEN_KEY);
        return state;
      }
      return transition('signed-in', user);
    },

    async login(credentials) {
      const session = await provider.authenticate(credentials);
      // Persist the token BEFORE announcing signed-in, so a crash can't leave a
      // signed-in UI with no stored token.
      secrets.set(AUTH_TOKEN_KEY, session.token);
      return transition('signed-in', session.user);
    },

    async logout() {
      const token = secrets.get(AUTH_TOKEN_KEY);
      if (token) {
        try {
          await provider.revoke(token);
        } catch {
          // Best-effort; we clear local state regardless.
        }
      }
      secrets.delete(AUTH_TOKEN_KEY);
      return transition('signed-out', null);
    },
  };
}
