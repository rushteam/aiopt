// App-shortcut IPC — the write path for user rebinds, plus the recording gate.
//
// Faithful port of Cindy's app-shortcut IPC surface, adapted to AiOpt's registry
// seam. Three concerns live here:
//
//   1. Mutations (rebind / disable / reset) go through the IpcHandlerRegistry so
//      they inherit the trusted-sender assertion + error sanitization every other
//      invoke channel gets. Main re-validates each write via AppShortcutStore (the
//      renderer's pre-check is a UX convenience, never the authority).
//   2. A synchronous `get` and a one-way `set-recording` use raw ipcMain, like the
//      theme sync channel: both assert the trusted sender directly and fail safe.
//   3. The recording gate: while the settings page is capturing a keystroke, the
//      native menu must not fire an accelerator for that same keystroke. This
//      module owns the flag and exposes a getter + subscription the menu consumes;
//      the flag auto-resets if the recording window is destroyed mid-capture.

import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron';
import {
  IPC_CHANNELS,
  IPC_EVENTS,
  IPC_SEND_CHANNELS,
  IPC_SYNC_CHANNELS,
  type AppShortcutsMutationResult,
} from '../../shared/ipc-channels';
import type { IpcErrorCode } from '../../shared/ipc-errors';
import type { IpcHandlerRegistry } from '../ipc/registry';
import { requireObject, throwIpcError } from '../ipc/validate';
import { assertTrustedAppRendererEvent } from '../security/trustedSender';
import { broadcastToRenderers } from '../ipc/broadcast';
import { logger } from '../logger';
import type { AppShortcutOverrideRejection, AppShortcutStore } from './AppShortcutStore';

const log = logger.child('app-shortcuts');

// ---------------------------------------------------------------------------
// Recording gate
// ---------------------------------------------------------------------------
//
// Module-local because there is exactly one native menu and one recording session
// at a time. The menu subscribes to rebuild with accelerators (un)registered.

let recordingActive = false;
let recordingSenderId: number | null = null;
const recordingListeners = new Set<(active: boolean) => void>();

/** True while the settings page is capturing a keystroke — the menu unregisters accelerators. */
export function isAppShortcutRecordingActive(): boolean {
  return recordingActive;
}

/** Subscribe to recording-gate changes (the native menu rebuilds on toggle). */
export function subscribeAppShortcutRecording(listener: (active: boolean) => void): () => void {
  recordingListeners.add(listener);
  return () => recordingListeners.delete(listener);
}

function setRecordingActive(active: boolean, senderId: number | null): void {
  if (recordingActive === active && recordingSenderId === (active ? senderId : null)) return;
  recordingActive = active;
  recordingSenderId = active ? senderId : null;
  recordingListeners.forEach((listener) => listener(active));
}

/** Map a store rejection to a generic IPC error code (never a business-specific one). */
function rejectionCode(rejection: AppShortcutOverrideRejection): IpcErrorCode {
  switch (rejection) {
    case 'unknown-id':
      return 'NOT_FOUND';
    case 'not-rebindable':
      return 'PRECONDITION_FAILED';
    case 'platform-unavailable':
      return 'UNSUPPORTED_CAPABILITY';
    case 'conflict':
      return 'ALREADY_EXISTS';
    case 'invalid-combo':
    case 'not-bindable':
    case 'system-reserved':
    case 'menu-inexpressible':
      return 'INVALID_PARAMS';
  }
}

/**
 * Register the three mutation channels on the registry (trusted-sender +
 * sanitization come from the Electron adapter). Each returns the full override set
 * so the caller can replace its local copy without a second read.
 */
export function registerAppShortcutIpc(
  registry: IpcHandlerRegistry,
  store: AppShortcutStore,
): void {
  const result = (): AppShortcutsMutationResult => ({ overrides: store.getOverrides() });

  registry.register(IPC_CHANNELS.appShortcutsSetOverride, (payload, meta) => {
    meta.assertTrustedSender();
    const body = requireObject(payload);
    // `combo` may legitimately be null (disable). The store validates both id and
    // combo at runtime; we forward the raw values and translate its rejection.
    const rejection = store.setOverride(body.id, body.combo);
    if (rejection) {
      throwIpcError(rejectionCode(rejection), `cannot bind shortcut: ${rejection}`);
    }
    return result();
  });

  registry.register(IPC_CHANNELS.appShortcutsClearOverride, (payload, meta) => {
    meta.assertTrustedSender();
    const body = requireObject(payload);
    store.clearOverride(body.id);
    return result();
  });

  registry.register(IPC_CHANNELS.appShortcutsResetAll, (_payload, meta) => {
    meta.assertTrustedSender();
    store.resetAll();
    return result();
  });
}

/**
 * Install the raw (non-registry) channels: the synchronous overrides read and the
 * one-way recording toggle. Both assert the trusted sender directly and fail safe
 * — a hostile or early caller gets an empty result and learns nothing.
 */
export function installAppShortcutSyncChannels(store: AppShortcutStore, platform: string): void {
  ipcMain.on(IPC_SYNC_CHANNELS.appShortcutsGet, (event: IpcMainEvent) => {
    try {
      assertTrustedAppRendererEvent(event as unknown as IpcMainInvokeEvent);
      event.returnValue = { overrides: store.getOverrides(), platform };
    } catch {
      event.returnValue = { overrides: {}, platform };
    }
  });

  ipcMain.on(IPC_SEND_CHANNELS.appShortcutsSetRecording, (event: IpcMainEvent, payload: unknown) => {
    try {
      assertTrustedAppRendererEvent(event as unknown as IpcMainInvokeEvent);
    } catch {
      return; // Untrusted sender: ignore silently, never toggle the gate.
    }
    const recording =
      Boolean(payload && typeof payload === 'object' && (payload as { recording?: unknown }).recording);
    const sender = event.sender;
    setRecordingActive(recording, sender.id);
    if (recording) resetRecordingWhenSenderGone(sender);
  });
}

/**
 * Guard against a stuck gate: if the window that started recording is destroyed
 * (closed / reloaded) before it clears the flag, reset it so the menu re-arms.
 */
function resetRecordingWhenSenderGone(sender: WebContents): void {
  const onGone = () => {
    if (recordingSenderId === sender.id) {
      log.warn('recording_sender_gone', {});
      setRecordingActive(false, null);
    }
  };
  sender.once('destroyed', onGone);
}

/**
 * Broadcast the changed overrides to every window. Wired as the store's onChanged
 * so a rebind in one window propagates to all (and to the renderer store copy).
 */
export function broadcastAppShortcutChange(overrides: Record<string, unknown>): void {
  broadcastToRenderers(IPC_EVENTS.appShortcutsChanged, { overrides });
}
