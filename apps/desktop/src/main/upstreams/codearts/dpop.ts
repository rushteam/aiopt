// PKCE + DPoP (ES256) helpers for CodeArts STS token exchange.
// Uses WebCrypto; no network I/O.

import { webcrypto } from 'node:crypto';
import { b64urlJson, base64Url, randomHex } from './sign';
import type { CodeArtsDpopJwk } from './session';

const subtle = webcrypto.subtle;

export interface CodeArtsPkcePair {
  verifier: string;
  challenge: string;
}

export interface CodeArtsDpopKeyPair {
  privateKeyJwk: CodeArtsDpopJwk;
  publicKeyJwk: CodeArtsDpopJwk;
}

export async function generateCodeArtsPkce(): Promise<CodeArtsPkcePair> {
  const verifier = base64Url(Buffer.from(webcrypto.getRandomValues(new Uint8Array(48))));
  const digest = await subtle.digest('SHA-256', Buffer.from(verifier, 'utf8'));
  return { verifier, challenge: base64Url(Buffer.from(digest)) };
}

export async function generateCodeArtsDpopKeyPair(): Promise<CodeArtsDpopKeyPair> {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const jwk = (await subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
  const privateKeyJwk: CodeArtsDpopJwk = {
    kty: 'EC',
    crv: 'P-256',
    x: String(jwk.x),
    y: String(jwk.y),
    d: String(jwk.d),
  };
  const publicKeyJwk: CodeArtsDpopJwk = {
    kty: 'EC',
    crv: 'P-256',
    x: privateKeyJwk.x,
    y: privateKeyJwk.y,
  };
  return { privateKeyJwk, publicKeyJwk };
}

export function dpopKeyPairFromPrivateJwk(jwk: CodeArtsDpopJwk): CodeArtsDpopKeyPair {
  return {
    privateKeyJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d },
    publicKeyJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y },
  };
}

/** Sign a dpop+jwt proof for method+URL. */
export async function signCodeArtsDpop(
  keyPair: CodeArtsDpopKeyPair,
  method: string,
  url: string,
): Promise<string> {
  const header = { alg: 'ES256', typ: 'dpop+jwt', jwk: keyPair.publicKeyJwk };
  const payload = {
    htm: method.toUpperCase(),
    htu: url,
    iat: Math.floor(Date.now() / 1000),
    jti: randomHex(16),
  };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const key = await subtle.importKey(
    'jwk',
    keyPair.privateKeyJwk as JsonWebKey,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const sig = await subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    Buffer.from(signingInput, 'utf8'),
  );
  return `${signingInput}.${base64Url(Buffer.from(sig))}`;
}
