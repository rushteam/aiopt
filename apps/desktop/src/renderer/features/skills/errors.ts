// Map a thrown IPC error to a `skills.errors.*` i18n key.
//
// IPC failures cross the boundary as `[CODE] message` strings (see
// shared/ipc-errors). We recover the code and translate it to a friendly line;
// anything unrecognized falls back to a generic message. Mirrors providers/errors.

import { decodeIpcError } from '../../../shared/ipc-errors';
import type { TranslateFn } from '../../i18n';

export function skillsErrorMessage(t: TranslateFn, err: unknown): string {
  const code = err instanceof Error ? decodeIpcError(err.message).code : 'INTERNAL';
  const key = `skills.errors.${code}`;
  const translated = t(key);
  // `t` returns the key itself when there's no entry — fall back to the generic one.
  return translated === key ? t('skills.errors.INTERNAL') : translated;
}
