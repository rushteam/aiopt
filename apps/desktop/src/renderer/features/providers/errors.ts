// Map a thrown IPC error to a `providers.errors.*` i18n key.
//
// IPC failures cross the boundary as `[CODE] message` strings (see
// shared/ipc-errors). We recover the code and translate it to a friendly line;
// anything unrecognized falls back to a generic message.

import { decodeIpcError } from '../../../shared/ipc-errors';
import type { TranslateFn } from '../../i18n';

/** Preload/main out of sync — common when only the renderer hot-reloaded. */
export function isAgentImportBridgeStale(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const m = err.message;
  return (
    m.includes('agentImportScan') ||
    m.includes('agent-import-scan') ||
    m.includes('No handler registered') ||
    m.includes('agent import scan is unavailable')
  );
}

export function providerErrorMessage(t: TranslateFn, err: unknown): string {
  const code = err instanceof Error ? decodeIpcError(err.message).code : 'INTERNAL';
  const key = `providers.errors.${code}`;
  const translated = t(key);
  // `t` returns the key itself when there's no entry — fall back to the generic one.
  return translated === key ? t('providers.errors.INTERNAL') : translated;
}

export function agentImportErrorMessage(t: TranslateFn, err: unknown): string {
  if (isAgentImportBridgeStale(err)) {
    return t('providers.import.errors.restartRequired');
  }
  return providerErrorMessage(t, err);
}
