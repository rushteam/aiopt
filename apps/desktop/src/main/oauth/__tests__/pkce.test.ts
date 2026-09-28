import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generatePkce } from '../pkce';

describe('generatePkce', () => {
  it('derives S256 challenge from verifier', () => {
    const { verifier, challenge } = generatePkce();
    expect(verifier.length).toBeGreaterThan(20);
    const expected = createHash('sha256')
      .update(verifier)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(challenge).toBe(expected);
  });

  it('generates distinct pairs', () => {
    const a = generatePkce();
    const b = generatePkce();
    expect(a.verifier).not.toBe(b.verifier);
  });
});
