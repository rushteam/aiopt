// Map a thrown IPC error to a `providers.errors.*` i18n key.
//
// IPC failures cross the boundary as `[CODE] message` strings (see
// shared/ipc-errors). We recover the code and translate it to a friendly line;
// anything unrecognized falls back to a generic message.

import { decodeIpcError } from '../../../shared/ipc-errors';
import type { TranslateFn } from '../../i18n';

export function providerErrorMessage(t: TranslateFn, err: unknown): string {
  const code = err instanceof Error ? decodeIpcError(err.message).code : 'INTERNAL';
  const key = `providers.errors.${code}`;
  const translated = t(key);
  // `t` returns the key itself when there's no entry — fall back to the generic one.
  return translated === key ? t('providers.errors.INTERNAL') : translated;
}
