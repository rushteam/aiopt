import { describe, expect, it } from 'vitest';
import {
  GITHUB_RELEASES_LATEST_URL,
  compareStableVersion,
  createGithubReleaseUpdateProvider,
  parseStableVersion,
  type ReleaseFetchResponse,
} from '../githubReleaseUpdateProvider';

function release(body: unknown, status = 200, url = GITHUB_RELEASES_LATEST_URL): ReleaseFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function fetchReturning(response: ReleaseFetchResponse) {
  return createGithubReleaseUpdateProvider(async (url) => {
    expect(url).toBe(GITHUB_RELEASES_LATEST_URL);
    return response;
  });
}

describe('parseStableVersion', () => {
  it('accepts a v-prefixed or bare stable triple', () => {
    expect(parseStableVersion('v1.2.3')).toEqual([1, 2, 3]);
    expect(parseStableVersion('1.2.3')).toEqual([1, 2, 3]);
  });

  it('rejects prerelease and junk', () => {
    expect(parseStableVersion('v1.2.3-beta.1')).toBeNull();
    expect(parseStableVersion('latest')).toBeNull();
    expect(parseStableVersion('')).toBeNull();
  });
});

describe('compareStableVersion', () => {
  it('compares numerically, not as strings', () => {
    expect(compareStableVersion([1, 10, 0], [1, 9, 0])).toBeGreaterThan(0);
    expect(compareStableVersion([1, 0, 4], [1, 0, 4])).toBe(0);
    expect(compareStableVersion([1, 0, 3], [1, 0, 4])).toBeLessThan(0);
  });
});

describe('github release update provider', () => {
  const published = { tag_name: 'v1.0.5', draft: false, prerelease: false };

  it('reports a strictly newer stable release', async () => {
    const provider = fetchReturning(release(published));
    expect(await provider.checkForUpdates('1.0.4')).toEqual({
      state: 'update-available',
      nextVersion: '1.0.5',
    });
  });

  it('treats the same or an older release as up to date', async () => {
    const provider = fetchReturning(release(published));
    expect(await provider.checkForUpdates('1.0.5')).toEqual({ state: 'up-to-date' });
    expect(await provider.checkForUpdates('1.0.6')).toEqual({ state: 'up-to-date' });
  });

  it('ignores a draft or prerelease that somehow came back from latest', async () => {
    const draft = fetchReturning(release({ ...published, draft: true }));
    expect(await draft.checkForUpdates('1.0.4')).toEqual({ state: 'up-to-date' });
    const pre = fetchReturning(release({ ...published, prerelease: true }));
    expect(await pre.checkForUpdates('1.0.4')).toEqual({ state: 'up-to-date' });
  });

  it('treats no published release as up to date', async () => {
    const provider = fetchReturning(release('', 404));
    expect(await provider.checkForUpdates('1.0.4')).toEqual({ state: 'up-to-date' });
  });

  it('fails closed on a bad status, payload, tag, or current version', async () => {
    expect(await fetchReturning(release(published, 500)).checkForUpdates('1.0.4')).toEqual({
      state: 'error',
    });
    expect(await fetchReturning(release({ tag_name: 5 })).checkForUpdates('1.0.4')).toEqual({
      state: 'error',
    });
    expect(
      await fetchReturning(release({ tag_name: 'nightly', draft: false, prerelease: false })).checkForUpdates(
        '1.0.4',
      ),
    ).toEqual({ state: 'error' });
    expect(await fetchReturning(release(published)).checkForUpdates('dev')).toEqual({ state: 'error' });
  });

  it('refuses a response that left api.github.com', async () => {
    const provider = fetchReturning(release(published, 200, 'https://evil.example/releases/latest'));
    expect(await provider.checkForUpdates('1.0.4')).toEqual({ state: 'error' });
  });

  it('reports a network failure as an error', async () => {
    const provider = createGithubReleaseUpdateProvider(async () => {
      throw new Error('offline');
    });
    expect(await provider.checkForUpdates('1.0.4')).toEqual({ state: 'error' });
  });
});
