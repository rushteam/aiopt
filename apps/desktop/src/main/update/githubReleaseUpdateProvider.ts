// Check-only update feed: "is a newer stable GitHub Release published?"
//
// This does NOT download or install anything. The URL is pinned in main (the renderer
// cannot choose it). Transport is HTTPS to api.github.com; a redirect off that host is
// refused. Only a published, non-prerelease tag of the form vX.Y.Z can be reported, and
// only when it is strictly newer than the running version — equal or older is up-to-date.
// Download, signature check, and install stay gated by docs/dev-rules/updater.md.

import { logger } from '../logger';
import type { UpdateCheckResult, UpdateProvider } from './updateProvider';

/** Pinned metadata URL. `/releases/latest` is the newest published, non-prerelease release. */
export const GITHUB_RELEASES_LATEST_URL =
  'https://api.github.com/repos/rushteam/aiopt/releases/latest';

const REQUEST_TIMEOUT_MS = 15_000;
/** Refuse a body large enough to be something other than one release's JSON. */
const MAX_BODY_CHARS = 64 * 1024;

export interface ReleaseFetchResponse {
  ok: boolean;
  status: number;
  /** Final URL after redirects. Empty or off-host is a failed check. */
  url: string;
  text(): Promise<string>;
}

export type ReleaseFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<ReleaseFetchResponse>;

const STABLE = /^(\d+)\.(\d+)\.(\d+)$/;

/** `v1.2.3` or `1.2.3` → numeric triple. Anything else (prerelease, junk) is null. */
export function parseStableVersion(tag: string): [number, number, number] | null {
  const raw = tag.startsWith('v') ? tag.slice(1) : tag;
  const match = STABLE.exec(raw);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Negative when `left` is older, 0 when equal, positive when `left` is newer. */
export function compareStableVersion(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i]! - right[i]!;
  }
  return 0;
}

function isPinnedReleaseResponse(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      parsed.host === 'api.github.com' &&
      parsed.pathname.startsWith('/repos/rushteam/aiopt/releases')
    );
  } catch {
    return false;
  }
}

function readRelease(body: unknown): { tag: string; draft: boolean; prerelease: boolean } | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  if (typeof record.tag_name !== 'string') return null;
  if (typeof record.draft !== 'boolean' || typeof record.prerelease !== 'boolean') return null;
  return { tag: record.tag_name, draft: record.draft, prerelease: record.prerelease };
}

export function createGithubReleaseUpdateProvider(fetchImpl: ReleaseFetch): UpdateProvider {
  return {
    async checkForUpdates(currentVersion: string): Promise<UpdateCheckResult> {
      const current = parseStableVersion(currentVersion);
      if (!current) {
        logger.warn('update.check_failed', { reason: 'bad_current_version' });
        return { state: 'error' };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await fetchImpl(GITHUB_RELEASES_LATEST_URL, {
          method: 'GET',
          headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': 'AiOpt',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          signal: controller.signal,
        });
        if (!isPinnedReleaseResponse(response.url)) {
          logger.warn('update.check_failed', { reason: 'unpinned_response' });
          return { state: 'error' };
        }
        // No published stable release yet (drafts and prereleases are excluded by this URL).
        if (response.status === 404) return { state: 'up-to-date' };
        if (!response.ok) {
          logger.warn('update.check_failed', { reason: 'http', status: response.status });
          return { state: 'error' };
        }
        const text = await response.text();
        if (text.length > MAX_BODY_CHARS) {
          logger.warn('update.check_failed', { reason: 'body_too_large' });
          return { state: 'error' };
        }
        const release = readRelease(JSON.parse(text) as unknown);
        if (!release) {
          logger.warn('update.check_failed', { reason: 'bad_payload' });
          return { state: 'error' };
        }
        if (release.draft || release.prerelease) return { state: 'up-to-date' };
        const next = parseStableVersion(release.tag);
        if (!next) {
          logger.warn('update.check_failed', { reason: 'bad_tag' });
          return { state: 'error' };
        }
        if (compareStableVersion(next, current) <= 0) return { state: 'up-to-date' };
        const nextVersion = `${next[0]}.${next[1]}.${next[2]}`;
        logger.info('update.available', { nextVersion });
        return { state: 'update-available', nextVersion };
      } catch {
        logger.warn('update.check_failed', { reason: 'network' });
        return { state: 'error' };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
