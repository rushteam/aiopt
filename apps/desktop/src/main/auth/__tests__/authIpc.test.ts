import { describe, expect, it } from 'vitest';
import {
  createInMemoryRegistry,
  type IpcInvokeMeta,
  type InMemoryIpcRegistry,
} from '../../ipc/registry';
import { throwIpcError } from '../../ipc/validate';
import { registerAuthIpc } from '../authIpc';
import { createAuthManager, AUTH_TOKEN_KEY } from '../authManager';
import { createLocalStubAuthProvider } from '../localStubAuthProvider';
import type { SecretStore } from '../../secrets/secretStore';
import { IPC_CHANNELS, type AuthState } from '../../../shared/ipc-channels';
import { decodeIpcError, isIpcError, type IpcErrorCode } from '../../../shared/ipc-errors';

const trusted: IpcInvokeMeta = { assertTrustedSender: () => {} };
const untrusted: IpcInvokeMeta = {
  assertTrustedSender: () => throwIpcError('PERMISSION_DENIED', 'nope'),
};

function memorySecrets(): SecretStore & { raw: Map<string, string> } {
  const raw = new Map<string, string>();
  return {
    raw,
    isAvailable: () => true,
    set: (k, v) => void raw.set(k, v),
    get: (k) => raw.get(k) ?? null,
    has: (k) => raw.has(k),
    delete: (k) => void raw.delete(k),
  };
}

function harness(): { reg: InMemoryIpcRegistry; secrets: ReturnType<typeof memorySecrets> } {
  const reg = createInMemoryRegistry();
  const secrets = memorySecrets();
  const manager = createAuthManager(createLocalStubAuthProvider(), secrets, () => {});
  registerAuthIpc(reg, manager);
  return { reg, secrets };
}

async function codeOf(fn: () => Promise<unknown>): Promise<IpcErrorCode> {
  try {
    await fn();
  } catch (err) {
    if (isIpcError(err)) return err.code;
    if (err instanceof Error) return decodeIpcError(err.message).code;
  }
  throw new Error('expected the invocation to throw');
}

describe('auth IPC', () => {
  it('get-state returns the current state for a trusted sender', async () => {
    const { reg } = harness();
    const state = (await reg.invoke(IPC_CHANNELS.authGetState, undefined, trusted)) as AuthState;
    expect(state).toEqual({ status: 'signed-out', user: null });
  });

  it('login goes signed-in and returns state carrying no token', async () => {
    const { reg, secrets } = harness();
    const state = (await reg.invoke(
      IPC_CHANNELS.authLogin,
      { username: 'ada', password: 'pw-not-real' },
      trusted,
    )) as AuthState;
    expect(state.status).toBe('signed-in');
    expect(state.user?.displayName).toBe('ada');
    // The result must not leak the persisted token.
    expect(JSON.stringify(state)).not.toContain(secrets.raw.get(AUTH_TOKEN_KEY)!);
  });

  it('logout returns to signed-out', async () => {
    const { reg } = harness();
    await reg.invoke(IPC_CHANNELS.authLogin, { username: 'ada', password: 'pw-not-real' }, trusted);
    const state = (await reg.invoke(IPC_CHANNELS.authLogout, undefined, trusted)) as AuthState;
    expect(state).toEqual({ status: 'signed-out', user: null });
  });

  it('rejects an untrusted login with PERMISSION_DENIED and stores nothing', async () => {
    const { reg, secrets } = harness();
    expect(
      await codeOf(() =>
        reg.invoke(IPC_CHANNELS.authLogin, { username: 'ada', password: 'pw' }, untrusted),
      ),
    ).toBe('PERMISSION_DENIED');
    expect(secrets.raw.size).toBe(0);
  });

  it('rejects login missing a field with INVALID_PARAMS', async () => {
    const { reg } = harness();
    expect(
      await codeOf(() => reg.invoke(IPC_CHANNELS.authLogin, { username: 'ada' }, trusted)),
    ).toBe('INVALID_PARAMS');
    expect(
      await codeOf(() => reg.invoke(IPC_CHANNELS.authLogin, { password: 'pw' }, trusted)),
    ).toBe('INVALID_PARAMS');
  });
});
