// IpcHandlerRegistry — the seam that makes IPC handlers testable without Electron.
//
// A handler receives the validated-later payload plus a `meta` object whose only
// authority-bearing member is `assertTrustedSender()`. The in-memory registry
// (tests) and the Electron adapter (production) implement the SAME interface, so
// a handler's authorization + validation logic is exercised in a plain unit test.
// See docs/dev-rules/electron-security-and-process-boundaries.md §5.

import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { assertTrustedAppRendererEvent } from '../security/trustedSender';
import { encodeIpcError, isIpcError } from '../../shared/ipc-errors';
import { logger } from '../logger';

const log = logger.child('ipc');

/** Authority + context handed to a handler. The trusted-sender check lives here. */
export interface IpcInvokeMeta {
  /** Throws PERMISSION_DENIED unless the call came from the trusted app renderer. */
  assertTrustedSender(): void;
}

export type IpcHandler<Req = unknown, Res = unknown> = (
  payload: Req,
  meta: IpcInvokeMeta,
) => Res | Promise<Res>;

export interface IpcHandlerRegistry {
  /** Register a handler for a channel. Registering the same channel twice throws. */
  register(channel: string, handler: IpcHandler): void;
}

/**
 * In-memory registry for tests. Adds `invoke()` so a test can drive a handler
 * with an explicit meta (trusted or not) and payload — no Electron required.
 */
export interface InMemoryIpcRegistry extends IpcHandlerRegistry {
  invoke(channel: string, payload: unknown, meta: IpcInvokeMeta): Promise<unknown>;
}

export function createInMemoryRegistry(): InMemoryIpcRegistry {
  const handlers = new Map<string, IpcHandler>();
  return {
    register(channel, handler) {
      if (handlers.has(channel)) {
        throw new Error(`duplicate IPC handler for channel: ${channel}`);
      }
      handlers.set(channel, handler);
    },
    async invoke(channel, payload, meta) {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`no IPC handler registered for channel: ${channel}`);
      return handler(payload, meta);
    },
  };
}

/**
 * Electron adapter. Wires each registered channel into `ipcMain.handle`, builds
 * the meta from the real invoke event, and sanitizes thrown errors: the full
 * detail is logged in main, and only a coded, safe message crosses to the
 * renderer (no stack, no internals). See the security rule §5 / conventions §2.
 */
export function createElectronIpcRegistry(ipcMain: IpcMain): IpcHandlerRegistry {
  const registered = new Set<string>();
  return {
    register(channel, handler) {
      if (registered.has(channel)) {
        throw new Error(`duplicate IPC handler for channel: ${channel}`);
      }
      registered.add(channel);

      ipcMain.handle(channel, async (event: IpcMainInvokeEvent, payload: unknown) => {
        const meta: IpcInvokeMeta = {
          assertTrustedSender: () => assertTrustedAppRendererEvent(event),
        };
        try {
          return await handler(payload, meta);
        } catch (err) {
          if (isIpcError(err)) {
            // Coded, intentional error — log the code, re-surface the safe wire
            // message only.
            log.warn('ipc.handler_error', { channel, code: err.code });
            throw new Error(err.message);
          }
          // Unexpected error — log detail in main, return a generic INTERNAL to
          // the renderer. Never leak the original message/stack.
          log.error('ipc.handler_crash', {
            channel,
            reason: err instanceof Error ? err.name : typeof err,
          });
          throw new Error(encodeIpcError('INTERNAL', 'internal error'));
        }
      });
    },
  };
}
