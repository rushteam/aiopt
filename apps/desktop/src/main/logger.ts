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

// --- defense-in-depth sanitizer ---------------------------------------------
//
// Callers already log only names, codes and counts. This is the floor underneath them:
// every field passes through it in `emit`, so an `err.message` that happens to carry a
// home directory, an email, or a credential (an upstream echoing a key, a URL with a token)
// is scrubbed before it reaches the sink. It never makes a field MORE revealing, only less.

/** Field names whose value is replaced outright, whatever it is. */
const SECRET_KEY = /(^|_|-)(api[_-]?key|apikey|token|access[_-]?token|refresh[_-]?token|id[_-]?token|secret|password|passwd|authorization|auth|cookie|set-cookie|session|credential|private[_-]?key|signature)s?$/i;

const MAX_STRING = 512;
const MAX_DEPTH = 4;
const MAX_ITEMS = 32;

const SECRET_PATTERNS: [RegExp, string][] = [
  // Authorization header values.
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]'],
  // Vendor key shapes (sk-…, sk-ant-…, ghp_…, xox…-, AIza…, ksk_…).
  [/\b(sk|rk|pk)-[A-Za-z0-9_-]{12,}/g, '[redacted]'],
  [/\b(ghp|gho|ghu|ghs|ghr|github_pat|ksk|xox[abpors])[_-][A-Za-z0-9_-]{10,}/g, '[redacted]'],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, '[redacted]'],
  // JWTs.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted]'],
  // Query-string credentials.
  [/([?&](?:key|api_key|apikey|token|access_token|code|sig|signature)=)[^&\s"']+/gi, '$1[redacted]'],
  // Long opaque hex / base64 runs (tokens, hashes of secrets).
  [/\b[A-Fa-f0-9]{40,}\b/g, '[redacted]'],
  [/[A-Za-z0-9+_-]{64,}={0,2}/g, '[redacted]'],
];

/**
 * Absolute paths under a per-user / per-machine root inside free text: keep only the last
 * segment (as {@link maskPath}). Rooted at the places a username or home lives, so an API
 * path like `/v1/messages` (which the proxy logs on purpose) is left alone.
 */
const PATH_IN_TEXT =
  /(?:\/(?:Users|home|root|var\/folders|private|tmp|Volumes|mnt|opt)\/|[A-Za-z]:[\\/]|\\\\)(?:[^\s"'`:;,()<>|]*[\\/])*([^\s"'`:;,()<>|\\/]*)/g;
const EMAIL_IN_TEXT = /\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;

function scrubString(value: string): string {
  let out = value;
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  out = out.replace(PATH_IN_TEXT, (_m, last: string) => `…/${last}`);
  out = out.replace(EMAIL_IN_TEXT, '$1***@$2');
  return out.length > MAX_STRING ? `${out.slice(0, MAX_STRING)}…[+${out.length - MAX_STRING}]` : out;
}

/**
 * Scrub a log value: redact secret-named fields, scrub credential / path / email shapes in
 * strings, flatten Errors to their (scrubbed) name + message, and bound depth, list length
 * and string length so one odd value cannot flood the sink. Pure; never throws.
 */
export function sanitizeForLog(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || value === undefined) return value;
  switch (typeof value) {
    case 'string':
      return scrubString(value);
    case 'number':
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'object':
      break;
    default:
      return `[${typeof value}]`;
  }
  const obj = value as object;
  if (seen.has(obj)) return '[circular]';
  if (depth >= MAX_DEPTH) return '[depth]';
  seen.add(obj);
  if (obj instanceof Error) return { name: obj.name, message: scrubString(obj.message) };
  if (Array.isArray(obj)) {
    const items = obj.slice(0, MAX_ITEMS).map((v) => sanitizeForLog(v, depth + 1, seen));
    if (obj.length > MAX_ITEMS) items.push(`[+${obj.length - MAX_ITEMS}]`);
    return items;
  }
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (n++ >= MAX_ITEMS) {
      out['…'] = `[+${Object.keys(obj).length - MAX_ITEMS}]`;
      break;
    }
    // Numbers / booleans pass (a `tokens` count is not a credential); anything else under a
    // secret-shaped name is withheld.
    const secretShaped = SECRET_KEY.test(k) && v !== null && v !== undefined && typeof v !== 'number' && typeof v !== 'boolean';
    out[k] = secretShaped ? '[redacted]' : sanitizeForLog(v, depth + 1, seen);
  }
  return out;
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
    ...((fields ? sanitizeForLog(fields) : {}) as LogFields),
  };
  // JSON.stringify drops undefined and is safe for structured ingestion. Callers mask
  // values first; sanitizeForLog is the backstop for what they miss.
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
