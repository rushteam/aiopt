import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dshInstallDirExists, dshSessionSnapshot, readDshAccessTokenSync } from '../dshSession';

let home: string;
let prevHome: string | undefined;
let prevDsh: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'aiopt-dsh-import-'));
  prevHome = process.env.AIOPT_AGENT_HOME;
  prevDsh = process.env.DSH_HOME;
  process.env.AIOPT_AGENT_HOME = home;
  process.env.DSH_HOME = '/nonexistent/should-not-be-read';
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.AIOPT_AGENT_HOME;
  else process.env.AIOPT_AGENT_HOME = prevHome;
  if (prevDsh === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = prevDsh;
  fs.rmSync(home, { recursive: true, force: true });
});

const writeCreds = (text: string): string => {
  const dir = path.join(home, '.dsh');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, '.credentials.yaml');
  fs.writeFileSync(f, text, { mode: 0o600 });
  return f;
};

describe('dsh session', () => {
  it('is not installed without ~/.dsh, and unavailable without a key', () => {
    expect(dshInstallDirExists()).toBe(false);
    fs.mkdirSync(path.join(home, '.dsh'));
    expect(dshInstallDirExists()).toBe(true);
    expect(dshSessionSnapshot().available).toBe(false);
    expect(readDshAccessTokenSync()).toBeNull();
  });

  it('reads DEEPSEEK_API_KEY from the version 1 layout', () => {
    writeCreds('# keys\nversion: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-live\n  AIOPT_P1_KEY: sk-ours\n');
    expect(dshSessionSnapshot()).toEqual({ available: true, accountLabel: 'DEEPSEEK_API_KEY' });
    expect(readDshAccessTokenSync()).toBe('sk-live');
  });

  it('reads the pre-release flat layout', () => {
    writeCreds('DEEPSEEK_API_KEY: sk-flat\n');
    expect(readDshAccessTokenSync()).toBe('sk-flat');
  });

  it('never imports the keys AiOpt’s own binding wrote, nor a malformed file', () => {
    writeCreds('version: 1\nrefs:\n  AIOPT_P1_KEY: sk-ours\n');
    expect(readDshAccessTokenSync()).toBeNull();
    writeCreds('version: 1\nrefs: [x]\n');
    expect(readDshAccessTokenSync()).toBeNull();
    writeCreds('a: [unclosed\n');
    expect(readDshAccessTokenSync()).toBeNull();
    writeCreds('version: 1\nrefs:\n  DEEPSEEK_API_KEY: "   "\n');
    expect(dshSessionSnapshot().available).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('does not follow a symlinked credentials file', () => {
    const real = path.join(home, 'elsewhere.yaml');
    fs.writeFileSync(real, 'DEEPSEEK_API_KEY: sk-elsewhere\n');
    fs.mkdirSync(path.join(home, '.dsh'));
    fs.symlinkSync(real, path.join(home, '.dsh', '.credentials.yaml'));
    expect(readDshAccessTokenSync()).toBeNull();
  });
});
