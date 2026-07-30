import { describe, expect, it } from 'vitest';
import { createAuthManager, AUTH_TOKEN_KEY } from '../authManager';
import { createLocalStubAuthProvider } from '../localStubAuthProvider';
import type { AuthProvider } from '../authProvider';
import type { SecretStore } from '../../secrets/secretStore';
import type { AuthState } from '../../../shared/ipc-channels';

/** In-memory secret store; `raw` lets a test inspect exactly what was persisted. */
function memorySecrets(seed: Record<string, string> = {}): SecretStore & { raw: Map<string, string> } {
  const raw = new Map<string, string>(Object.entries(seed));
  return {
    raw,
    isAvailable: () => true,
    set: (k, v) => void raw.set(k, v),
    get: (k) => raw.get(k) ?? null,
    has: (k) => raw.has(k),
    delete: (k) => void raw.delete(k),
  };
}

/** Build a manager over the real stub provider; capture every broadcast state. */
function harness(seed: Record<string, string> = {}) {
  const secrets = memorySecrets(seed);
  const events: AuthState[] = [];
  const manager = createAuthManager(createLocalStubAuthProvider(), secrets, (s) => events.push(s));
  return { manager, secrets, events };
}

describe('auth manager', () => {
  it('starts signed-out', () => {
    const { manager } = harness();
    expect(manager.getState()).toEqual({ status: 'signed-out', user: null });
  });

  it('login goes signed-in, persists a token, and broadcasts', async () => {
    const { manager, secrets, events } = harness();
    const state = await manager.login({ username: 'ada', password: 'pw-not-real' });

    expect(state.status).toBe('signed-in');
    expect(state.user?.displayName).toBe('ada');
    expect(events).toEqual([state]);
    // A token was persisted under the main-only key...
    expect(secrets.raw.has(AUTH_TOKEN_KEY)).toBe(true);
  });

  it('never puts the token (or the password) in the renderer-visible state', async () => {
    const { manager, secrets } = harness();
    const state = await manager.login({ username: 'ada', password: 'pw-not-real' });
    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain(secrets.raw.get(AUTH_TOKEN_KEY)!);
    expect(serialized).not.toContain('pw-not-real');
  });

  it('restores a signed-in session from a persisted token on initialize', async () => {
    // First manager logs in and persists a token.
    const first = harness();
    await first.manager.login({ username: 'grace', password: 'pw-not-real' });
    const persisted = Object.fromEntries(first.secrets.raw);

    // A fresh manager over the SAME persisted secrets restores the identity.
    const second = harness(persisted);
    const state = await second.manager.initialize();
    expect(state.status).toBe('signed-in');
    expect(state.user?.displayName).toBe('grace');
    expect(second.events).toEqual([state]);
  });

  it('drops an invalid persisted token and stays signed-out', async () => {
    const { manager, secrets, events } = harness({ [AUTH_TOKEN_KEY]: 'not-a-stub-token' });
    const state = await manager.initialize();
    expect(state.status).toBe('signed-out');
    expect(secrets.raw.has(AUTH_TOKEN_KEY)).toBe(false);
    expect(events).toEqual([]); // no transition broadcast for a no-op restore
  });

  it('logout clears the token, goes signed-out, and broadcasts', async () => {
    const { manager, secrets, events } = harness();
    await manager.login({ username: 'ada', password: 'pw-not-real' });
    const state = await manager.logout();
    expect(state).toEqual({ status: 'signed-out', user: null });
    expect(secrets.raw.has(AUTH_TOKEN_KEY)).toBe(false);
    expect(events.at(-1)).toEqual(state);
  });

  it('propagates a provider rejection and persists nothing', async () => {
    const rejecting: AuthProvider = {
      authenticate: async () => {
        throw new Error('[PERMISSION_DENIED] bad credentials');
      },
      restore: async () => null,
      revoke: async () => {},
    };
    const secrets = memorySecrets();
    const manager = createAuthManager(rejecting, secrets, () => {});
    await expect(manager.login({ username: 'x', password: 'y' })).rejects.toThrow();
    expect(manager.getState().status).toBe('signed-out');
    expect(secrets.raw.has(AUTH_TOKEN_KEY)).toBe(false);
  });
});
