import { describe, expect, it } from 'vitest';
import { tomlLine, tomlString, tomlTableHeader, tomlValue } from '../tomlLite';

describe('tomlLite', () => {
  it('quotes and escapes string values like a TOML basic string', () => {
    expect(tomlString('hello')).toBe('"hello"');
    expect(tomlString('a"b\\c')).toBe('"a\\"b\\\\c"');
  });

  it('emits numbers and booleans as bare literals', () => {
    expect(tomlValue(500000)).toBe('500000');
    expect(tomlValue(true)).toBe('true');
    expect(tomlValue('x')).toBe('"x"');
  });

  it('renders key = value lines', () => {
    expect(tomlLine('base_url', 'https://x')).toBe('base_url = "https://x"');
    expect(tomlLine('context_window', 500000)).toBe('context_window = 500000');
    expect(tomlLine('requires_openai_auth', true)).toBe('requires_openai_auth = true');
  });

  it('keeps bare-safe table segments bare and quotes the rest', () => {
    expect(tomlTableHeader('model_providers', 'custom')).toBe('[model_providers.custom]');
    expect(tomlTableHeader('model', 'grok-2.5')).toBe('[model."grok-2.5"]');
  });
});
