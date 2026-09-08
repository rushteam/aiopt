import { describe, expect, it, vi } from 'vitest';
import {
  createInMemoryRegistry,
  type IpcInvokeMeta,
} from '../../ipc/registry';
import { throwIpcError } from '../../ipc/validate';
import { registerUsageIpc } from '../usageIpc';
import { createUsageStore, type UsagePersistence } from '../usageStore';
import type { UsageEventInput, UsageSnapshot } from '../../../shared/usageStats';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';

const trusted: IpcInvokeMeta = { assertTrustedSender: () => {} };
const untrusted: IpcInvokeMeta = {
  assertTrustedSender: () => throwIpcError('PERMISSION_DENIED', 'nope'),
};

function memoryPersistence(): UsagePersistence {
  let lines: unknown[] = [];
  return {
    load: () => lines,
    append: (e) => void lines.push(e),
    rewrite: (events) => void (lines = [...events]),
  };
}

function input(overrides: Partial<UsageEventInput> = {}): UsageEventInput {
  return {
    agentId: 'codex',
    providerId: 'p1',
    model: 'm',
    inboundFormat: 'openai-responses',
    outboundFormat: 'openai',
    streamed: false,
    ok: true,
    status: 200,
    inputTokens: 4,
    outputTokens: 6,
    ...overrides,
  };
}

describe('usage IPC', () => {
  it('get returns the current snapshot; assertTrustedSender is called', async () => {
    const reg = createInMemoryRegistry();
    const store = createUsageStore(memoryPersistence(), { now: () => 1000 });
    store.record(input());
    registerUsageIpc(reg, store);

    const spy = vi.fn();
    const snap = (await reg.invoke(IPC_CHANNELS.usageGet, undefined, {
      assertTrustedSender: spy,
    })) as UsageSnapshot;
    expect(spy).toHaveBeenCalledOnce();
    expect(snap.totals.requests).toBe(1);
    expect(snap.totals.totalTokens).toBe(10);
  });

  it('clear empties the store and returns the emptied snapshot', async () => {
    const reg = createInMemoryRegistry();
    const store = createUsageStore(memoryPersistence(), { now: () => 1000 });
    store.record(input());
    registerUsageIpc(reg, store);

    const snap = (await reg.invoke(IPC_CHANNELS.usageClear, undefined, trusted)) as UsageSnapshot;
    expect(snap.totals.requests).toBe(0);
    expect(((await reg.invoke(IPC_CHANNELS.usageGet, undefined, trusted)) as UsageSnapshot).eventCount).toBe(0);
  });

  it('rejects an untrusted sender before touching the store', async () => {
    const reg = createInMemoryRegistry();
    const store = createUsageStore(memoryPersistence(), { now: () => 1000 });
    store.record(input());
    registerUsageIpc(reg, store);

    await expect(reg.invoke(IPC_CHANNELS.usageClear, undefined, untrusted)).rejects.toThrow();
    // Store untouched: the record is still there.
    expect(((await reg.invoke(IPC_CHANNELS.usageGet, undefined, trusted)) as UsageSnapshot).eventCount).toBe(1);
  });
});
