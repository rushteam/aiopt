import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSkillPaths } from '../skillsPaths';
import { decodeIpcError, isIpcError } from '../../../shared/ipc-errors';
import type { AgentId } from '../../../shared/aiProviders';

const paths = createSkillPaths({ centralDir: '/lib/skills', homeDir: '/home/u' });

function codeOf(fn: () => void): string {
  try {
    fn();
  } catch (err) {
    if (isIpcError(err)) return err.code;
    if (err instanceof Error) return decodeIpcError(err.message).code;
  }
  throw new Error('expected the call to throw a coded error');
}

describe('createSkillPaths — agent dirs', () => {
  it('joins a known agent dir onto home', () => {
    expect(paths.agentDir('claude')).toBe(path.resolve('/home/u/.claude/skills'));
  });

  it('returns null for an agent with no known dir', () => {
    expect(paths.agentDir('grok')).toBeNull();
  });
});

describe('createSkillPaths — central skill path', () => {
  it('resolves a valid name to a direct child of central', () => {
    expect(paths.centralSkillPath('my-skill')).toBe(path.resolve('/lib/skills/my-skill'));
  });

  it('rejects traversal, separators, and absolute-ish names', () => {
    expect(codeOf(() => paths.centralSkillPath('..'))).toBe('INVALID_PARAMS');
    expect(codeOf(() => paths.centralSkillPath('a/b'))).toBe('INVALID_PARAMS');
    expect(codeOf(() => paths.centralSkillPath('../escape'))).toBe('INVALID_PARAMS');
    expect(codeOf(() => paths.centralSkillPath('.hidden'))).toBe('INVALID_PARAMS');
  });
});

describe('createSkillPaths — agent skill path', () => {
  it('resolves a valid name under the agent dir', () => {
    expect(paths.agentSkillPath('codex', 'foo')).toBe(path.resolve('/home/u/.codex/skills/foo'));
  });

  it('rejects an unknown agent id', () => {
    expect(codeOf(() => paths.agentSkillPath('bogus' as AgentId, 'foo'))).toBe('INVALID_PARAMS');
  });

  it('reports agents without a known dir as unsupported', () => {
    expect(codeOf(() => paths.agentSkillPath('grok', 'foo'))).toBe('UNSUPPORTED_CAPABILITY');
  });

  it('rejects a bad name before touching the filesystem', () => {
    expect(codeOf(() => paths.agentSkillPath('claude', '../../etc'))).toBe('INVALID_PARAMS');
  });
});
