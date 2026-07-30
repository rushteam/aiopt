// Structured, PII-masked logging for the main process.
//
// Emit structured events (a stable name + fields), never interpolated prose, and
// never a secret / token / raw absolute path. See
// docs/dev-rules/engineering-conventions.md §1.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  [key: string]: unknown;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * Reduce a filesystem path to a non-identifying shape: keep only the last
 * segment, replace the rest with `…`. Enough to correlate, not enough to leak a
 * home directory or username.
 */
export function maskPath(value: string): string {
  if (!value) return value;
  const normalized = value.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0) return '…';
  const last = segments[segments.length - 1] ?? '…';
  return segments.length === 1 ? last : `…/${last}`;
}

/** Keep only the first character of the local part and the domain. */
export function maskEmail(value: string): string {
  const at = value.indexOf('@');
  if (at <= 0) return '***';
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  const head = local[0] ?? '';
  return `${head}***@${domain}`;
}

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  child(scope: string): Logger;
}

interface LoggerOptions {
  scope: string;
  minLevel: LogLevel;
  sink: (line: string) => void;
}

function emit(opts: LoggerOptions, level: LogLevel, event: string, fields?: LogFields): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[opts.minLevel]) return;
  const record = {
    level,
    scope: opts.scope,
    event,
    ...(fields ?? {}),
  };
  // JSON.stringify drops undefined and is safe for structured ingestion. Callers
  // are responsible for masking values before they get here.
  opts.sink(JSON.stringify(record));
}

function make(opts: LoggerOptions): Logger {
  return {
    debug: (event, fields) => emit(opts, 'debug', event, fields),
    info: (event, fields) => emit(opts, 'info', event, fields),
    warn: (event, fields) => emit(opts, 'warn', event, fields),
    error: (event, fields) => emit(opts, 'error', event, fields),
    child: (scope) => make({ ...opts, scope: `${opts.scope}.${scope}` }),
  };
}

const DEFAULT_MIN_LEVEL: LogLevel =
  process.env.NODE_ENV === 'production' ? 'info' : 'debug';

/** Create a scoped logger. In production the default floor is `info`. */
export function createLogger(scope: string, minLevel: LogLevel = DEFAULT_MIN_LEVEL): Logger {
  return make({
    scope,
    minLevel,
    sink: (line) => {
      // eslint-disable-next-line no-console -- the logger IS the console boundary
      console.log(line);
    },
  });
}

export const logger = createLogger('main');
