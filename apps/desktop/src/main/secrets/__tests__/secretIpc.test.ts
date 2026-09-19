import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createInMemoryRegistry,
  type IpcInvokeMeta,
  type InMemoryIpcRegistry,
} from '../../ipc/registry';
import { throwIpcError } from '../../ipc/validate';
import { registerSecretIpc } from '../secretIpc';
import { createSecretStore, type SecretCryptor } from '../secretStore';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import { decodeIpcError, isIpcError, type IpcErrorCode } from '../../../shared/ipc-errors';

const trusted: IpcInvokeMeta = { assertTrustedSender: () => {} };
const untrusted: IpcInvokeMeta = {
  assertTrustedSender: () => throwIpcError('PERMISSION_DENIED', 'nope'),
};

function fakeCryptor(): SecretCryptor {
  const TAG = 'enc:';
  return {
    isEncryptionAvailable: () => true,
    encryptString: (p) => Buffer.from(TAG + p, 'utf8'),
    decryptString: (b) => b.toString('utf8').slice(TAG.length),
  };
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

describe('secret IPC', () => {
  let dir: string;
  let reg: InMemoryIpcRegistry;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiopt-secret-ipc-'));
    reg = createInMemoryRegistry();
    registerSecretIpc(reg, createSecretStore(dir, fakeCryptor()));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('set → has round-trips for a trusted sender', async () => {
    await reg.invoke(IPC_CHANNELS.secretSet, { key: 'api_key', value: 'shhh' }, trusted);
    expect(await reg.invoke(IPC_CHANNELS.secretHas, { key: 'api_key' }, trusted)).toEqual({ present: true });
  });

  it('exposes NO channel that returns plaintext to the renderer', () => {
    // The contract must not grow a secret-get channel; the renderer can never
    // read plaintext back. This guards against a future regression.
    const channels = Object.values(IPC_CHANNELS);
    expect(channels.some((c) => c.startsWith('secret:') && c.includes('get'))).toBe(false);
  });

  it('delete clears a stored secret', async () => {
    await reg.invoke(IPC_CHANNELS.secretSet, { key: 'api_key', value: 'shhh' }, trusted);
    await reg.invoke(IPC_CHANNELS.secretDelete, { key: 'api_key' }, trusted);
    expect(await reg.invoke(IPC_CHANNELS.secretHas, { key: 'api_key' }, trusted)).toEqual({ present: false });
  });

  it('rejects an untrusted sender with PERMISSION_DENIED', async () => {
    expect(
      await codeOf(() => reg.invoke(IPC_CHANNELS.secretSet, { key: 'api_key', value: 'x' }, untrusted)),
    ).toBe('PERMISSION_DENIED');
  });

  it('rejects a main-only key with PERMISSION_DENIED', async () => {
    expect(
      await codeOf(() => reg.invoke(IPC_CHANNELS.secretSet, { key: 'main_auth_token', value: 'x' }, trusted)),
    ).toBe('PERMISSION_DENIED');
    expect(await codeOf(() => reg.invoke(IPC_CHANNELS.secretHas, { key: 'main_auth_token' }, trusted))).toBe(
      'PERMISSION_DENIED',
    );
  });

  it('rejects a path-traversal key with INVALID_PARAMS', async () => {
    expect(await codeOf(() => reg.invoke(IPC_CHANNELS.secretSet, { key: '../evil', value: 'x' }, trusted))).toBe(
      'INVALID_PARAMS',
    );
  });

  it('rejects a missing value with INVALID_PARAMS', async () => {
    expect(await codeOf(() => reg.invoke(IPC_CHANNELS.secretSet, { key: 'api_key' }, trusted))).toBe(
      'INVALID_PARAMS',
    );
  });
});
