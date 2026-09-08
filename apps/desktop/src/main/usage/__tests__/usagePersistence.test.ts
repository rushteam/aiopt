import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileUsagePersistence } from '../usageStore';
import type { UsageEvent } from '../../../shared/usageStats';

function event(ts: number): UsageEvent {
  return {
    ts,
    agentId: 'codex',
    providerId: 'p1',
    model: 'm',
    inboundFormat: 'openai-responses',
    outboundFormat: 'openai',
    streamed: false,
    ok: true,
    status: 200,
    inputTokens: 1,
    outputTokens: 2,
  };
}

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiopt-usage-'));
  file = path.join(dir, 'nested', 'usage-history.jsonl');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('createFileUsagePersistence', () => {
  it('loads an empty array when the file is absent', () => {
    expect(createFileUsagePersistence(file).load()).toEqual([]);
  });

  it('appends one JSONL line per event, creating the directory', () => {
    const p = createFileUsagePersistence(file);
    p.append(event(1));
    p.append(event(2));
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).ts).toBe(1);
    expect(p.load()).toHaveLength(2);
  });

  it('skips corrupt lines on load', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(event(1))}\nnot-json\n\n${JSON.stringify(event(2))}\n`, 'utf8');
    expect(createFileUsagePersistence(file).load()).toHaveLength(2);
  });

  it('rewrite atomically replaces the whole log and leaves no temp file', () => {
    const p = createFileUsagePersistence(file);
    p.append(event(1));
    p.append(event(2));
    p.rewrite([event(3)]);
    expect(p.load()).toHaveLength(1);
    expect((p.load()[0] as UsageEvent).ts).toBe(3);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
  });

  it('rewrite with an empty list truncates to an empty file', () => {
    const p = createFileUsagePersistence(file);
    p.append(event(1));
    p.rewrite([]);
    expect(p.load()).toEqual([]);
    expect(fs.readFileSync(file, 'utf8')).toBe('');
  });
});
