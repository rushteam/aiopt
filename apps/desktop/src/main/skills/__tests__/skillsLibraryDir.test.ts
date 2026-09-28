import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isRealDirectory, skillsLibraryDir } from '../skillsLibraryDir';

const roots = { userData: '/data/AiOpt', home: '/home/ada' };

describe('skillsLibraryDir', () => {
  it('keeps app inside userData and the other two under home', () => {
    expect(skillsLibraryDir('app', roots, path.posix)).toBe('/data/AiOpt/skills');
    expect(skillsLibraryDir('home', roots, path.posix)).toBe('/home/ada/.aiopt/skills');
    expect(skillsLibraryDir('agents', roots, path.posix)).toBe('/home/ada/.agents/skills');
  });

  it('joins with Windows separators when given path.win32', () => {
    const win = { userData: 'C:\\Users\\Ada\\AppData\\Roaming\\AiOpt', home: 'C:\\Users\\Ada' };
    expect(skillsLibraryDir('app', win, path.win32)).toBe('C:\\Users\\Ada\\AppData\\Roaming\\AiOpt\\skills');
    expect(skillsLibraryDir('home', win, path.win32)).toBe('C:\\Users\\Ada\\.aiopt\\skills');
    expect(skillsLibraryDir('agents', win, path.win32)).toBe('C:\\Users\\Ada\\.agents\\skills');
  });
});

describe('isRealDirectory', () => {
  it('accepts a real directory and rejects a missing path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiopt-skills-'));
    try {
      expect(isRealDirectory(dir)).toBe(true);
      expect(isRealDirectory(path.join(dir, 'missing'))).toBe(false);
      const file = path.join(dir, 'file.txt');
      fs.writeFileSync(file, 'x');
      expect(isRealDirectory(file)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
