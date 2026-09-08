import { describe, expect, it } from 'vitest';
import {
  AGENTS,
  AGENT_IDS,
  API_FORMATS,
  OFFICIAL_PROVIDERS,
  OFFICIAL_PROVIDER_ID_PREFIX,
  getAgentDef,
  isFormatCompatible,
  translationSupported,
  type Provider,
} from '../aiProviders';

function providerWithFormat(apiFormat: Provider['apiFormat']): Provider {
  return {
    id: 'p1',
    name: 'Example',
    apiFormat,
    baseUrl: 'https://api.example.com',
    models: [{ id: 'm1' }],
    createdAt: 0,
  };
}

describe('aiProviders registry', () => {
  it('every AGENT_IDS entry has exactly one definition, and vice versa', () => {
    expect(AGENTS.map((a) => a.id).sort()).toEqual([...AGENT_IDS].sort());
    for (const id of AGENT_IDS) expect(getAgentDef(id)?.id).toBe(id);
  });

  it('every agent accepts only known API formats', () => {
    for (const agent of AGENTS) {
      for (const fmt of agent.acceptedFormats) {
        expect(API_FORMATS).toContain(fmt);
      }
      expect(agent.acceptedFormats.length).toBeGreaterThan(0);
    }
  });

  it('getAgentDef returns undefined for an unknown id', () => {
    // Cast through unknown: the runtime lookup, not the type, is under test.
    expect(getAgentDef('nope' as never)).toBeUndefined();
  });
});

describe('built-in provider presets', () => {
  it('every preset has a unique, prefixed id and a known format', () => {
    const ids = OFFICIAL_PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of OFFICIAL_PROVIDERS) {
      expect(p.id.startsWith(OFFICIAL_PROVIDER_ID_PREFIX)).toBe(true);
      expect(API_FORMATS).toContain(p.apiFormat);
      expect(p.baseUrl.length).toBeGreaterThan(0);
      expect(p.models.length).toBeGreaterThan(0);
    }
  });
});

describe('isFormatCompatible', () => {
  it('permits a provider whose format the agent accepts', () => {
    const claude = getAgentDef('claude')!; // accepts anthropic
    expect(isFormatCompatible(claude, providerWithFormat('anthropic'))).toBe(true);
  });

  it('rejects a provider whose format the agent does not accept', () => {
    const claude = getAgentDef('claude')!; // anthropic only
    expect(isFormatCompatible(claude, providerWithFormat('openai'))).toBe(false);
    expect(isFormatCompatible(claude, providerWithFormat('gemini'))).toBe(false);
  });

  it('a multi-format agent accepts any of its formats', () => {
    const opencode = getAgentDef('opencode')!; // openai + anthropic
    expect(isFormatCompatible(opencode, providerWithFormat('openai'))).toBe(true);
    expect(isFormatCompatible(opencode, providerWithFormat('anthropic'))).toBe(true);
    expect(isFormatCompatible(opencode, providerWithFormat('gemini'))).toBe(false);
  });
});

describe('translationSupported', () => {
  it('supports Anthropic ⇄ OpenAI Chat Completions both ways', () => {
    expect(translationSupported('anthropic', 'openai')).toBe(true);
    expect(translationSupported('openai', 'anthropic')).toBe(true);
  });

  it('supports OpenAI Responses → OpenAI Chat and → Anthropic', () => {
    expect(translationSupported('openai-responses', 'openai')).toBe(true);
    expect(translationSupported('openai-responses', 'anthropic')).toBe(true);
  });

  it('never targets an OpenAI Responses provider outbound', () => {
    expect(translationSupported('anthropic', 'openai-responses')).toBe(false);
    expect(translationSupported('openai', 'openai-responses')).toBe(false);
  });

  it('rejects same-format pairs (that is a direct binding, not translation)', () => {
    for (const f of API_FORMATS) expect(translationSupported(f, f)).toBe(false);
  });

  it('rejects any pairing involving gemini', () => {
    expect(translationSupported('gemini', 'openai')).toBe(false);
    expect(translationSupported('anthropic', 'gemini')).toBe(false);
    expect(translationSupported('openai-responses', 'gemini')).toBe(false);
  });
});
