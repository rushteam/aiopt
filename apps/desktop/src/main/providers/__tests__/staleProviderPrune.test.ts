// Switching an agent's binding from provider A to provider B must not leave A's
// `aiopt-<A>` entry (base URL, key / loopback token, models) behind in the agent's config —
// otherwise the agent's own model picker keeps offering a dead provider. Asserted for EVERY
// bindable adapter: "bind A, then B" must leave disk exactly as "bind B" alone does.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BINDABLE_ADAPTER_FACTORIES } from '../adapters/registry';
import { getAgentDef, type BindableAgentId, type Provider } from '../../../shared/aiProviders';

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  prevHome = process.env.AIOPT_AGENT_HOME;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.AIOPT_AGENT_HOME;
  else process.env.AIOPT_AGENT_HOME = prevHome;
});

function freshHome(): string {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiopt-prune-'));
  process.env.AIOPT_AGENT_HOME = home;
  return home;
}

function provider(id: string, url: string): Provider {
  return {
    id,
    name: `Provider ${id}`,
    apiFormats: ['openai', 'anthropic', 'openai-responses', 'gemini'],
    baseUrl: url,
    models: [{ id: `model-${id}` }],
    createdAt: 0,
  };
}

/** Every config file the adapter manages → its content (absent files skipped). */
function snapshot(agent: BindableAgentId): Record<string, string> {
  const adapter = BINDABLE_ADAPTER_FACTORIES[agent]();
  const out: Record<string, string> = {};
  for (const file of adapter.configPaths()) {
    if (!fs.existsSync(file)) continue;
    // Timestamps (Cline's `updatedAt`) differ run to run; they are not what this asserts.
    out[path.relative(home, file)] = fs
      .readFileSync(file, 'utf8')
      .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, '<ts>');
  }
  return out;
}

function bind(agent: BindableAgentId, p: Provider, key: string): void {
  const def = getAgentDef(agent)!;
  BINDABLE_ADAPTER_FACTORIES[agent]().writeLive({
    provider: p,
    apiFormat: def.acceptedFormats[0]!,
    modelId: p.models[0]!.id,
    apiKey: key,
  });
}

const A = provider('stale-aaaa', 'http://127.0.0.1:1111/route-a');
const B = provider('fresh-bbbb', 'https://api.example.com');

describe('binding switch prunes the previous provider entry', () => {
  for (const agent of Object.keys(BINDABLE_ADAPTER_FACTORIES) as BindableAgentId[]) {
    it(`${agent}: bind A then B == bind B alone`, () => {
      const onlyB = freshHome();
      bind(agent, B, 'sk-b');
      const expected = snapshot(agent);
      fs.rmSync(onlyB, { recursive: true, force: true });

      const switched = freshHome();
      bind(agent, A, 'sk-a');
      bind(agent, B, 'sk-b');
      const actual = snapshot(agent);
      fs.rmSync(switched, { recursive: true, force: true });

      // Backups (`*.aiopt.bak`) are not managed paths, so they are not in the snapshot.
      expect(actual).toEqual(expected);
      const all = Object.values(actual).join('\n').toLowerCase();
      expect(all).not.toContain('stale');
      expect(all).not.toContain('sk-a');
      expect(all).not.toContain('127.0.0.1:1111');
    });
  }
});

describe('pruning keeps the user’s own entries', () => {
  it('pi: non-aiopt providers and auth survive', () => {
    const h = freshHome();
    const dir = path.join(h, '.pi', 'agent');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'models.json'),
      JSON.stringify({ providers: { mine: { baseUrl: 'https://mine' }, 'aiopt-old': { baseUrl: 'x' } } }),
    );
    fs.writeFileSync(
      path.join(dir, 'auth.json'),
      JSON.stringify({ mine: { type: 'api_key', key: 'k' }, 'aiopt-old': { type: 'api_key', key: 'o' } }),
    );
    bind('pi', B, 'sk-b');
    const models = JSON.parse(fs.readFileSync(path.join(dir, 'models.json'), 'utf8'));
    const auth = JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'));
    expect(Object.keys(models.providers).sort()).toEqual(['aiopt-fresh-bbbb', 'mine']);
    expect(Object.keys(auth).sort()).toEqual(['aiopt-fresh-bbbb', 'mine']);
    fs.rmSync(h, { recursive: true, force: true });
  });

  it('hermes: user custom_providers and comments survive', () => {
    const h = freshHome();
    fs.mkdirSync(path.join(h, '.hermes'), { recursive: true });
    const file = path.join(h, '.hermes', 'config.yaml');
    fs.writeFileSync(
      file,
      '# my hermes\ncustom_providers:\n  - name: mine\n    base_url: https://mine\n  - name: aiopt-old\n    base_url: x\n',
    );
    bind('hermes', B, 'sk-b');
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('# my hermes');
    expect(text).toContain('name: mine');
    expect(text).not.toContain('aiopt-old');
    expect(text).toContain('aiopt-fresh-bbbb');
    fs.rmSync(h, { recursive: true, force: true });
  });

  it('dsh: own credential refs survive, other AiOpt refs go', () => {
    const h = freshHome();
    fs.mkdirSync(path.join(h, '.dsh'), { recursive: true });
    const cred = path.join(h, '.dsh', '.credentials.yaml');
    fs.writeFileSync(cred, 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: ds-own\n  AIOPT_OLD_KEY: o\n', { mode: 0o600 });
    bind('dsh', B, 'sk-b');
    const text = fs.readFileSync(cred, 'utf8');
    expect(text).toContain('DEEPSEEK_API_KEY: ds-own');
    expect(text).not.toContain('AIOPT_OLD_KEY');
    expect(text).toContain('AIOPT_FRESH_BBBB_KEY: sk-b');
    fs.rmSync(h, { recursive: true, force: true });
  });
});
