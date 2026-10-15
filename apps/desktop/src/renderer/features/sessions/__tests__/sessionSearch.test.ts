import { describe, expect, it } from 'vitest';
import { activeMentionQuery, applyMention, searchSessions, sessionMatches, shortDir } from '../sessionSearch';
import type { SessionSummary } from '../../../../shared/agentSessions';

const base: SessionSummary = {
  agentId: 'claude',
  sessionId: '6f1c2a90-1d2e-4c55-9a51-0f7d3e2b8a11',
  title: 'Add retry to fetch',
  cwd: '/Users/me/src/aiopt',
  startedAt: 0,
  updatedAt: 0,
  model: 'claude-opus',
  gitBranch: 'feat/retry',
  messageCount: 1,
};

describe('session search', () => {
  it('matches every word against title, folder, branch, model, id or agent name', () => {
    expect(sessionMatches(base, '')).toBe(true);
    expect(sessionMatches(base, 'RETRY aiopt')).toBe(true);
    expect(sessionMatches(base, 'feat/retry')).toBe(true);
    expect(sessionMatches(base, '6f1c2a90')).toBe(true);
    expect(sessionMatches(base, 'claude code')).toBe(true);
    expect(sessionMatches(base, 'retry codex')).toBe(false);
  });

  it('returns the first matches up to the limit, in order', () => {
    const list = [1, 2, 3].map((n) => ({ ...base, sessionId: `${base.sessionId.slice(0, -1)}${n}`, title: `retry ${n}` }));
    expect(searchSessions(list, 'retry', 2).map((s) => s.title)).toEqual(['retry 1', 'retry 2']);
  });

  it('shortens long folders', () => {
    expect(shortDir('/Users/me/src/aiopt')).toBe('…/src/aiopt');
    expect(shortDir('C:\\work\\a\\b')).toBe('…/a/b');
    expect(shortDir('/tmp')).toBe('/tmp');
  });
});

describe('@ trigger', () => {
  it('finds the query being typed after a free-standing @', () => {
    expect(activeMentionQuery('@', 1)).toEqual({ start: 0, query: '' });
    expect(activeMentionQuery('see @add ret', 12)).toEqual({ start: 4, query: 'add ret' });
    expect(activeMentionQuery('mail a@b', 8)).toBeNull();
    expect(activeMentionQuery('@a\nb', 4)).toBeNull();
    expect(activeMentionQuery('@ x', 3)).toBeNull();
    expect(activeMentionQuery('@ab  ', 5)).toBeNull();
    expect(activeMentionQuery('@session:claude:abc', 19)).toBeNull();
    expect(activeMentionQuery('@task:abc', 9)).toBeNull();
    expect(activeMentionQuery('', 0)).toBeNull();
  });

  it('replaces the query with the token and a space, within the length cap', () => {
    const q = { start: 4, query: 'ret' };
    expect(applyMention('see @ret more', q, 8, '@task:x', 100)).toEqual({ text: 'see @task:x more', caret: 12 });
    expect(applyMention('see @ret', q, 8, '@task:x', 5)).toEqual({ text: 'see @ret', caret: 8 });
  });
});
