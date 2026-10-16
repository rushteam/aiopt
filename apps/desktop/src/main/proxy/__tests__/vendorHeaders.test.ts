import { describe, expect, it } from 'vitest';
import { vendorHeaders } from '../vendorHeaders';

describe('vendorHeaders', () => {
  it('sends a Command Code key both ways with the CLI identity', () => {
    expect(vendorHeaders('commandcode', 'k')).toMatchObject({
      authorization: 'Bearer k',
      'x-api-key': 'k',
      'x-cli-environment': 'production',
    });
  });
  it('sends a ZCode key both ways', () => {
    expect(vendorHeaders('zcode', 'k')).toEqual({ authorization: 'Bearer k', 'x-api-key': 'k' });
  });
  it('adds nothing for other providers or without a key', () => {
    expect(vendorHeaders('codex', 'k')).toEqual({});
    expect(vendorHeaders(undefined, 'k')).toEqual({});
    expect(vendorHeaders('zcode', null)).toEqual({});
  });
});
