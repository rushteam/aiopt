import { createHash, randomBytes } from 'node:crypto';

/** URL-safe base64 without padding. */
function base64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function generateOAuthState(): string {
  return base64Url(randomBytes(16));
}
