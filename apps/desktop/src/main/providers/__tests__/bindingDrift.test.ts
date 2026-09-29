import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectBindingDrift } from '../bindingDrift';
import type { AppliedBindingRecord } from '../bindingAppliedStore';
import { AGENT_FILES, resolveAgentFile } from '../agentPaths';
import { createAdapterRegistry } from '../adapters/registry';
import { createGrokAdapter } from '../adapters/grokAdapter';
import { createOpenCodeAdapter } from '../adapters/opencodeAdapter';
import { createHermesAdapter } from '../adapters/hermesAdapter';
import { createPiAdapter } from '../adapters/piAdapter';
import type { Provider } from '../../../shared/aiProviders';

let home: string;
let prevHome: string | undefined;

const adapters = createAdapterRegistry();

const appliedBase = (over: Partial<AppliedBindingRecord>): AppliedBindingRecord => ({
  baseUrl: 'https://api.example.com',
  modelId: 'model-a',
  authTokenSet: true,
  appliedAt: Date.now(),
  ...over,
});

const provider: Provider = {
  id: 'p1',
  name: 'Example',
  apiFormats: ['openai'],
  baseUrl: 'https://api.example.com',
  models: [{ id: 'model-a' }, { id: 'model-b' }],
  createdAt: 0,
};

const hermesProvider: Provider = {
  ...provider,
  apiFormats: ['openai', 'anthropic'],
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiopt-binding-drift-'));
  prevHome = process.env.AIOPT_AGENT_HOME;
  process.env.AIOPT_AGENT_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.AIOPT_AGENT_HOME;
  else process.env.AIOPT_AGENT_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('detectBindingDrift', () => {
  it('returns false when no applied record exists', () => {
    expect(detectBindingDrift(adapters.get('claude'), null)).toBe(false);
  });

  it('detects claude env drift', () => {
    const settings = resolveAgentFile(AGENT_FILES.claude.settings);
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(
      settings,
      `${JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: 'https://api.example.com',
          ANTHROPIC_MODEL: 'model-a',
          ANTHROPIC_AUTH_TOKEN: 'tok',
        },
      })}\n`,
    );
    const claude = adapters.get('claude')!;
    expect(
      detectBindingDrift(claude, appliedBase({ baseUrl: 'https://api.example.com' })),
    ).toBe(false);
    expect(
      detectBindingDrift(claude, appliedBase({ baseUrl: 'https://api.example.com', modelId: 'other' })),
    ).toBe(true);
  });

  it('detects pi binding drift via aiopt slug', () => {
    fs.mkdirSync(path.join(home, '.pi', 'agent'), { recursive: true });
    createPiAdapter().writeLive({
      provider,
      apiFormat: 'openai',
      modelId: 'model-a',
      apiKey: 'secret',
    });
    const pi = adapters.get('pi')!;
    expect(
      detectBindingDrift(
        pi,
        appliedBase({ providerId: 'p1', baseUrl: 'https://api.example.com' }),
      ),
    ).toBe(false);
    expect(
      detectBindingDrift(
        pi,
        appliedBase({ providerId: 'p1', baseUrl: 'https://changed.example.com' }),
      ),
    ).toBe(true);
  });

  it('detects grok toml drift', () => {
    fs.mkdirSync(path.join(home, '.grok'), { recursive: true });
    createGrokAdapter().writeLive({
      provider,
      apiFormat: 'openai',
      modelId: 'model-a',
      apiKey: 'key',
    });
    const grok = adapters.get('grok')!;
    expect(detectBindingDrift(grok, appliedBase({ baseUrl: 'https://api.example.com' }))).toBe(
      false,
    );
    expect(detectBindingDrift(grok, appliedBase({ authTokenSet: false }))).toBe(true);
  });

  it('detects opencode provider map drift', () => {
    fs.mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true });
    createOpenCodeAdapter().writeLive({
      provider,
      apiFormat: 'openai',
      modelId: 'model-a',
      apiKey: 'key',
    });
    const opencode = adapters.get('opencode')!;
    expect(
      detectBindingDrift(
        opencode,
        appliedBase({ providerId: 'p1', baseUrl: 'https://api.example.com' }),
      ),
    ).toBe(false);
    expect(
      detectBindingDrift(
        opencode,
        appliedBase({ providerId: 'p1', modelId: 'model-b' }),
      ),
    ).toBe(true);
  });

  it('detects hermes yaml drift', () => {
    fs.mkdirSync(path.join(home, '.hermes'), { recursive: true });
    createHermesAdapter().writeLive({
      provider: hermesProvider,
      apiFormat: 'openai',
      modelId: 'model-a',
      apiKey: 'key',
    });
    const hermes = adapters.get('hermes')!;
    expect(
      detectBindingDrift(
        hermes,
        appliedBase({ providerId: 'p1', baseUrl: 'https://api.example.com' }),
      ),
    ).toBe(false);
    expect(
      detectBindingDrift(
        hermes,
        appliedBase({ providerId: 'p1', baseUrl: 'https://evil.example.com' }),
      ),
    ).toBe(true);
  });

  it('compares dsh base URL and credentials without model on disk', () => {
    const slug = 'aiopt-p1';
    const credRef = 'AIOPT_P1_KEY';
    fs.mkdirSync(path.join(home, '.dsh'), { recursive: true });
    fs.writeFileSync(
      resolveAgentFile(AGENT_FILES.dsh.settings),
      `llm-pi-ai:
  providers:
    ${slug}:
      baseURL: https://api.example.com
      apiKeyEnv: ${credRef}
`,
    );
    fs.writeFileSync(
      resolveAgentFile(AGENT_FILES.dsh.credentials),
      `version: 1
refs:
  ${credRef}: secret
`,
      { mode: 0o600 },
    );
    const dsh = adapters.get('dsh')!;
    expect(
      detectBindingDrift(
        dsh,
        appliedBase({ providerId: 'p1', modelId: 'model-a', authTokenSet: true }),
      ),
    ).toBe(false);
    expect(
      detectBindingDrift(
        dsh,
        appliedBase({ providerId: 'p1', modelId: 'model-b', authTokenSet: true }),
      ),
    ).toBe(false);
  });

  it('detects gemini .env drift', () => {
    fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
    fs.writeFileSync(
      resolveAgentFile(AGENT_FILES.gemini.env),
      'GEMINI_API_KEY=key\nGEMINI_MODEL=model-a\nGOOGLE_GEMINI_BASE_URL=https://api.example.com\n',
    );
    const gemini = adapters.get('gemini')!;
    expect(
      detectBindingDrift(gemini, appliedBase({ baseUrl: 'https://api.example.com' })),
    ).toBe(false);
    expect(detectBindingDrift(gemini, appliedBase({ modelId: 'wrong' }))).toBe(true);
  });
});
