// Huawei SDK-HMAC-SHA256 request signing for CodeArts SnapEngine.
// Pure WebCrypto / node:crypto helpers — no I/O. Unit-tested.

import { createHash, createHmac, randomBytes } from 'node:crypto';

export function sha256Hex(data: string | Buffer | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hmacSha256Hex(key: string | Buffer, data: string | Buffer): string {
  return createHmac('sha256', key).update(data).digest('hex');
}

export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

function base64Url(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function b64urlJson(value: unknown): string {
  return base64Url(Buffer.from(JSON.stringify(value), 'utf8'));
}

export { base64Url };

/** Canonical request body for SDK-HMAC-SHA256 (Huawei). */
export function buildCanonicalRequest(
  method: string,
  uri: string,
  query: string,
  headers: Map<string, string>,
  payloadHash: string,
): string {
  const signedHeaders = [...headers.keys()].sort();
  const headerLines = signedHeaders.map((k) => `${k}:${headers.get(k) ?? ''}`);
  return [method, uri, query, headerLines.join('\n'), '', signedHeaders.join(';'), payloadHash].join(
    '\n',
  );
}

export interface SignRequestInput {
  accessKeyId: string;
  secretAccessKey: string;
  securityToken: string;
  method: string;
  url: string;
  body: string | Uint8Array;
  /** Extra headers that MUST also be sent (e.g. `maas_type: benefit`). */
  extraHeaders?: Record<string, string>;
  /** Test override for `x-sdk-date`. */
  dateStamp?: string;
}

/**
 * Sign a Huawei request. Returns headers to merge into the outbound call
 * (includes Authorization, x-sdk-*, x-security-token, host, content-type).
 */
export function signRequestHuawei(input: SignRequestInput): Record<string, string> {
  const url = new URL(input.url);
  let uri = url.pathname;
  if (!uri.endsWith('/')) uri += '/';
  const query = url.search.startsWith('?') ? url.search.slice(1) : url.search;
  const dateStamp =
    input.dateStamp ??
    new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const bodyBuf =
    typeof input.body === 'string' ? Buffer.from(input.body, 'utf8') : Buffer.from(input.body);
  const payloadHash = sha256Hex(bodyBuf);

  const headers = new Map<string, string>();
  headers.set('host', url.host);
  headers.set('x-sdk-date', dateStamp);
  headers.set('x-sdk-content-sha256', payloadHash);
  headers.set('x-security-token', input.securityToken);
  if (input.extraHeaders) {
    for (const [k, v] of Object.entries(input.extraHeaders)) headers.set(k, v);
  }
  if (input.method.toUpperCase() !== 'GET') headers.set('content-type', 'application/json');

  const signedHeaderNames = [...headers.keys()].sort();
  const canonicalRequest = buildCanonicalRequest(
    input.method.toUpperCase(),
    uri,
    query,
    headers,
    payloadHash,
  );
  const canonicalHash = sha256Hex(canonicalRequest);
  const stringToSign = `SDK-HMAC-SHA256\n${dateStamp}\n${canonicalHash}`;
  const signature = hmacSha256Hex(input.secretAccessKey, stringToSign);
  headers.set(
    'Authorization',
    `SDK-HMAC-SHA256 Access=${input.accessKeyId},SignedHeaders=${signedHeaderNames.join(';')},Signature=${signature}`,
  );

  const out: Record<string, string> = {};
  for (const [k, v] of headers) {
    // Host is set by the transport; do not force it on fetch.
    if (k === 'host') continue;
    out[k] = v;
  }
  return out;
}
