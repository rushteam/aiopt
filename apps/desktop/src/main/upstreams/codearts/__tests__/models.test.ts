import { describe, expect, it } from 'vitest';
import { createBenefitModelSet, normalizeCodeArtsModelId, parseCodeArtsModelInfo } from '../models';
import { buildCodeArtsAuthorizeUrl } from '../login';

describe('codearts models helpers', () => {
  it('strips trailing date suffixes and hides vision models', () => {
    expect(normalizeCodeArtsModelId('GLM-5.2-20260301')).toBe('GLM-5.2');
    const seen = new Set<string>();
    expect(parseCodeArtsModelInfo({ model_id: 'foo-VL-bar', model_name: 'x' }, seen)).toBeNull();
    expect(parseCodeArtsModelInfo({ model_id: 'GLM-5.2-20260301', model_name: 'GLM-5.2' }, seen)).toEqual({
      id: 'GLM-5.2',
    });
  });

  it('tracks benefit model ids', () => {
    const set = createBenefitModelSet(['glm-5.3-flash']);
    expect(set.has('glm-5.3-flash')).toBe(true);
    expect(set.has('deepseek-v4.1-flash')).toBe(true); // fallback
    set.remember(['custom-free']);
    expect(set.has('custom-free')).toBe(true);
  });
});

describe('codearts authorize URL', () => {
  it('includes portal params the desktop agent expects', () => {
    const url = new URL(
      buildCodeArtsAuthorizeUrl(12345, { verifier: 'v', challenge: 'ch' }, 'ticket'),
    );
    expect(url.origin + url.pathname).toBe('https://codearts.huaweicloud.com/portal/authorize');
    expect(url.searchParams.get('client_id')).toBe('codearts');
    expect(url.searchParams.get('port')).toBe('12345');
    expect(url.searchParams.get('code_challenge')).toBe('ch');
    expect(url.searchParams.get('code_challenge_method')).toBe('SHA-256');
    expect(url.searchParams.get('plugin-name')).toBe('snap_AIIDE');
  });
});
