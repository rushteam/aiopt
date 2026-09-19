import { describe, expect, it } from 'vitest';
import {
  AGENTS,
  AGENT_IDS,
  AGENT_NAMES,
  AGENT_SPECS,
  API_FORMATS,
  OFFICIAL_PROVIDERS,
  OFFICIAL_PROVIDER_ID_PREFIX,
  getAgentDef,
  isFormatCompatible,
  translationSupported,
  type AgentId,
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

describe('AGENT_SPECS derivation', () => {
  // These lock the single-source-of-truth invariants: everything is derived from
  // AGENT_SPECS, so a mistake in one derivation is caught here rather than silently.
  it('AGENT_IDS is exactly the keys of AGENT_SPECS, in table order', () => {
    expect(AGENT_IDS).toEqual(Object.keys(AGENT_SPECS));
  });

  it('AGENT_NAMES maps each id to its spec name', () => {
    for (const id of AGENT_IDS) {
      expect(AGENT_NAMES[id]).toBe(AGENT_SPECS[id].name);
    }
  });

  it('AGENTS is exactly the specs with a non-null binding, carrying their formats/mode', () => {
    const bindable = (Object.keys(AGENT_SPECS) as AgentId[]).filter((id) => AGENT_SPECS[id].binding !== null);
    expect(AGENTS.map((a) => a.id)).toEqual(bindable);
    for (const agent of AGENTS) {
      const binding = AGENT_SPECS[agent.id].binding!;
      expect(agent.name).toBe(AGENT_SPECS[agent.id].name);
      expect(agent.acceptedFormats).toEqual([...binding.acceptedFormats]);
      expect(agent.mode).toBe(binding.mode);
    }
  });

  it('a skills-only agent (cursor) has a null binding and is absent from AGENTS', () => {
    expect(AGENT_SPECS.cursor.binding).toBeNull();
    expect(AGENTS.some((a) => a.id === 'cursor')).toBe(false);
  });
});

describe('aiProviders registry', () => {
  it('the binding registry (AGENTS) is a subset of AGENT_IDS with unique, resolvable ids', () => {
    const bindingIds = AGENTS.map((a) => a.id);
    expect(new Set(bindingIds).size).toBe(bindingIds.length); // no duplicates
    for (const id of bindingIds) {
      expect(AGENT_IDS).toContain(id);
      expect(getAgentDef(id)?.id).toBe(id);
    }
  });

  it('AGENT_NAMES has a non-empty display name for every known agent id', () => {
    for (const id of AGENT_IDS) expect((AGENT_NAMES[id] ?? '').length).toBeGreaterThan(0);
  });

  it('cursor is known but skills-only (deliberately absent from the binding registry)', () => {
    // Cursor CLI has no bring-your-own-endpoint surface, so it can't bind a pool provider
    // and must never surface in Providers — but it is still a valid agent id (for Skills).
    expect(AGENT_IDS).toContain('cursor');
    expect(getAgentDef('cursor')).toBeUndefined();
    expect(AGENTS.some((a) => a.id === 'cursor')).toBe(false);
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

  it('supports same-format pairs as passthrough (identity + usage sniff), except gemini', () => {
    for (const f of API_FORMATS) {
      expect(translationSupported(f, f)).toBe(f !== 'gemini');
    }
  });

  it('rejects any pairing involving gemini', () => {
    expect(translationSupported('gemini', 'openai')).toBe(false);
    expect(translationSupported('anthropic', 'gemini')).toBe(false);
    expect(translationSupported('openai-responses', 'gemini')).toBe(false);
  });
});
