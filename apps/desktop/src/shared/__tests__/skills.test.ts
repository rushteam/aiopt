import { describe, expect, it } from 'vitest';
import { AGENT_IDS } from '../aiProviders';
import { AGENT_SKILL_DIRS, computeSyncState, isValidSkillName, newerSkillSide } from '../skills';

describe('isValidSkillName', () => {
  it('accepts ordinary single-segment names', () => {
    expect(isValidSkillName('my-skill')).toBe(true);
    expect(isValidSkillName('code_review')).toBe(true);
    expect(isValidSkillName('skill123')).toBe(true);
    expect(isValidSkillName('a')).toBe(true);
  });

  it('rejects empty, over-long, and non-strings', () => {
    expect(isValidSkillName('')).toBe(false);
    expect(isValidSkillName('x'.repeat(129))).toBe(false);
    expect(isValidSkillName(undefined)).toBe(false);
    expect(isValidSkillName(null)).toBe(false);
    expect(isValidSkillName(42)).toBe(false);
  });

  it('rejects traversal and path separators', () => {
    expect(isValidSkillName('..')).toBe(false);
    expect(isValidSkillName('.')).toBe(false);
    expect(isValidSkillName('../etc')).toBe(false);
    expect(isValidSkillName('a/b')).toBe(false);
    expect(isValidSkillName('a\\b')).toBe(false);
    expect(isValidSkillName('foo..bar')).toBe(false);
    expect(isValidSkillName('/absolute')).toBe(false);
  });

  it('rejects hidden (dot-leading) names', () => {
    expect(isValidSkillName('.ssh')).toBe(false);
    expect(isValidSkillName('.hidden')).toBe(false);
  });

  it('rejects control characters', () => {
    expect(isValidSkillName(`a${String.fromCharCode(0)}b`)).toBe(false);
    expect(isValidSkillName(`a${String.fromCharCode(10)}b`)).toBe(false);
    expect(isValidSkillName(`a${String.fromCharCode(127)}b`)).toBe(false);
  });
});

describe('computeSyncState', () => {
  it('classifies presence and difference', () => {
    expect(computeSyncState(true, true, false)).toBe('same');
    expect(computeSyncState(true, true, true)).toBe('differs');
    expect(computeSyncState(true, false, false)).toBe('central-only');
    expect(computeSyncState(false, true, false)).toBe('agent-only');
  });

  it('ignores `differs` unless both copies exist', () => {
    expect(computeSyncState(true, false, true)).toBe('central-only');
    expect(computeSyncState(false, true, true)).toBe('agent-only');
  });
});

describe('AGENT_SKILL_DIRS', () => {
  it('has an entry for every known agent id', () => {
    for (const id of AGENT_IDS) {
      expect(id in AGENT_SKILL_DIRS).toBe(true);
    }
    expect(Object.keys(AGENT_SKILL_DIRS).sort()).toEqual([...AGENT_IDS].sort());
  });

  it('uses home-relative (non-absolute) segments and marks grok unknown', () => {
    for (const [, dir] of Object.entries(AGENT_SKILL_DIRS)) {
      if (dir === null) continue;
      expect(dir.startsWith('/')).toBe(false);
      expect(dir.startsWith('~')).toBe(false);
      expect(dir.endsWith('skills')).toBe(true);
    }
    expect(AGENT_SKILL_DIRS.grok).toBeNull();
  });

  it('maps the skills-only agent cursor to ~/.cursor/skills', () => {
    expect(AGENT_SKILL_DIRS.cursor).toBe('.cursor/skills');
  });
});

describe('newerSkillSide', () => {
  const at = (modifiedAt: number) => ({ modifiedAt });

  it('returns the side with the larger mtime', () => {
    expect(newerSkillSide(at(2000), at(1000))).toBe('central');
    expect(newerSkillSide(at(1000), at(2000))).toBe('agent');
  });

  it('returns null on an exact tie', () => {
    expect(newerSkillSide(at(1500), at(1500))).toBeNull();
  });

  it('returns null when a copy is missing or a time is unknown', () => {
    expect(newerSkillSide(null, at(1000))).toBeNull();
    expect(newerSkillSide(at(1000), null)).toBeNull();
    expect(newerSkillSide(at(0), at(1000))).toBeNull();
    expect(newerSkillSide(at(1000), at(0))).toBeNull();
  });
});
