import { describe, expect, it } from 'vitest';
import {
  AGENTS,
  AGENT_IDS,
  AGENT_NAMES,
  AGENT_SPECS,
  API_FORMATS,
  OFFICIAL_PROVIDERS,
  OFFICIAL_PROVIDER_ID_PREFIX,
  bindingAvailability,
  getAgentDef,
  isFormatCompatible,
  normalizeApiFormats,
  resolveBindingRoute,
  translationSupported,
  type AgentId,
  type ApiFormat,
  type Provider,
} from '../aiProviders';

function providerWithFormats(...apiFormats: ApiFormat[]): Provider {
  return {
    id: 'p1',
    name: 'Example',
    apiFormats,
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
  it('every preset has a unique, prefixed id and at least one known format', () => {
    const ids = OFFICIAL_PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of OFFICIAL_PROVIDERS) {
      expect(p.id.startsWith(OFFICIAL_PROVIDER_ID_PREFIX)).toBe(true);
      expect(p.apiFormats.length).toBeGreaterThan(0);
      for (const f of p.apiFormats) expect(API_FORMATS).toContain(f);
      expect(p.baseUrl.length).toBeGreaterThan(0);
      expect(p.models.length).toBeGreaterThan(0);
    }
  });
});

describe('isFormatCompatible', () => {
  it('permits a provider whose format the agent accepts', () => {
    const claude = getAgentDef('claude')!; // accepts anthropic
    expect(isFormatCompatible(claude, providerWithFormats('anthropic'))).toBe(true);
  });

  it('rejects a provider whose format the agent does not accept', () => {
    const claude = getAgentDef('claude')!; // anthropic only
    expect(isFormatCompatible(claude, providerWithFormats('openai'))).toBe(false);
    expect(isFormatCompatible(claude, providerWithFormats('gemini'))).toBe(false);
  });

  it('a multi-format agent accepts any of its formats', () => {
    const opencode = getAgentDef('opencode')!; // openai + anthropic
    expect(isFormatCompatible(opencode, providerWithFormats('openai'))).toBe(true);
    expect(isFormatCompatible(opencode, providerWithFormats('anthropic'))).toBe(true);
    expect(isFormatCompatible(opencode, providerWithFormats('gemini'))).toBe(false);
  });

  it('a multi-format provider is compatible when any of its formats is accepted', () => {
    const claude = getAgentDef('claude')!;
    expect(isFormatCompatible(claude, providerWithFormats('openai', 'anthropic'))).toBe(true);
    expect(isFormatCompatible(claude, providerWithFormats('openai', 'gemini'))).toBe(false);
  });
});

describe('normalizeApiFormats', () => {
  it('keeps known formats in canonical order, dropping unknowns, blanks and duplicates', () => {
    expect(normalizeApiFormats(['openai', ' anthropic ', 'nope', 'openai', 3, null])).toEqual([
      'anthropic',
      'openai',
    ]);
    expect(normalizeApiFormats([])).toEqual([]);
  });
});

describe('resolveBindingRoute', () => {
  it('prefers the agent’s own format, in the agent’s order, when the provider serves it', () => {
    // Codex speaks only Responses; an OpenAI provider that serves both picks Responses.
    expect(resolveBindingRoute(getAgentDef('codex')!, ['openai', 'openai-responses'])).toEqual({
      kind: 'native',
      inbound: 'openai-responses',
      outbound: 'openai-responses',
    });
    // Claude speaks anthropic; a mixed provider is bound natively, not translated.
    expect(resolveBindingRoute(getAgentDef('claude')!, ['openai', 'anthropic'])).toEqual({
      kind: 'native',
      inbound: 'anthropic',
      outbound: 'anthropic',
    });
    // opencode lists openai before anthropic — the agent's order wins, not the provider's.
    expect(resolveBindingRoute(getAgentDef('opencode')!, ['anthropic', 'openai'])).toEqual({
      kind: 'native',
      inbound: 'openai',
      outbound: 'openai',
    });
  });

  it('falls back to a translated route from the agent’s first format', () => {
    expect(resolveBindingRoute(getAgentDef('claude')!, ['openai'])).toEqual({
      kind: 'translated',
      inbound: 'anthropic',
      outbound: 'openai',
    });
    // Codex → Chat is preferred over Codex → Anthropic when both are available.
    expect(resolveBindingRoute(getAgentDef('codex')!, ['anthropic', 'openai'])).toEqual({
      kind: 'translated',
      inbound: 'openai-responses',
      outbound: 'openai',
    });
    expect(resolveBindingRoute(getAgentDef('codex')!, ['anthropic'])).toEqual({
      kind: 'translated',
      inbound: 'openai-responses',
      outbound: 'anthropic',
    });
  });

  it('returns null when nothing native or translatable is served', () => {
    expect(resolveBindingRoute(getAgentDef('claude')!, ['gemini'])).toBeNull();
    expect(resolveBindingRoute(getAgentDef('claude')!, ['openai-responses'])).toBeNull();
    expect(resolveBindingRoute(getAgentDef('gemini')!, ['openai', 'anthropic'])).toBeNull();
    expect(resolveBindingRoute(getAgentDef('codex')!, [])).toBeNull();
  });
});

describe('bindingAvailability', () => {
  it('is native when the agent accepts one of the provider formats', () => {
    expect(bindingAvailability(getAgentDef('claude')!, ['anthropic'])).toBe('native');
    expect(bindingAvailability(getAgentDef('opencode')!, ['openai'])).toBe('native');
    expect(bindingAvailability(getAgentDef('opencode')!, ['anthropic'])).toBe('native');
    expect(bindingAvailability(getAgentDef('claude')!, ['openai', 'anthropic'])).toBe('native');
  });

  it('is translated when the formats differ but the agent’s first format can be translated', () => {
    // Claude speaks anthropic; an OpenAI Chat provider is translated.
    expect(bindingAvailability(getAgentDef('claude')!, ['openai'])).toBe('translated');
    // Codex speaks Responses; Chat Completions and Anthropic are both translated.
    expect(bindingAvailability(getAgentDef('codex')!, ['openai'])).toBe('translated');
    expect(bindingAvailability(getAgentDef('codex')!, ['anthropic'])).toBe('translated');
  });

  it('is unsupported when no translation route exists', () => {
    expect(bindingAvailability(getAgentDef('claude')!, ['gemini'])).toBe('unsupported');
    expect(bindingAvailability(getAgentDef('claude')!, ['openai-responses'])).toBe('unsupported');
    expect(bindingAvailability(getAgentDef('codex')!, ['gemini'])).toBe('unsupported');
    expect(bindingAvailability(getAgentDef('gemini')!, ['openai'])).toBe('unsupported');
    // pi's first format is anthropic, which cannot be translated into Responses.
    expect(bindingAvailability(getAgentDef('pi')!, ['openai-responses'])).toBe('unsupported');
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
