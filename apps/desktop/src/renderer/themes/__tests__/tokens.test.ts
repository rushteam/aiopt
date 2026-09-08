import { describe, expect, it } from 'vitest';
import {
  ELEVATION,
  TOKENS,
  applyThemeVariables,
  cssVarName,
  elevationVarName,
  type ElevationName,
  type StyleTarget,
  type TokenName,
} from '../tokens';
import { resolveTheme } from '../resolveTheme';

/** A CSSOM-shaped fake so applyThemeVariables tests without a DOM. */
function fakeTarget(): StyleTarget & { props: Record<string, string> } {
  const props: Record<string, string> = {};
  return {
    props,
    dataset: {},
    style: { setProperty: (k, v) => { props[k] = v; } },
  };
}

describe('design tokens (dual-mode gate)', () => {
  it('every semantic token defines BOTH a light and a dark value', () => {
    for (const name of Object.keys(TOKENS) as TokenName[]) {
      const value = TOKENS[name];
      expect(value.light, `${name}.light`).toMatch(/\S/);
      expect(value.dark, `${name}.dark`).toMatch(/\S/);
      // A token whose two modes are identical almost always means dark mode was
      // forgotten — the whole point is that they differ per mode.
      expect(value.light, `${name} light === dark`).not.toBe(value.dark);
    }
  });

  it('maps camelCase token names to kebab CSS variables', () => {
    expect(cssVarName('bg')).toBe('--color-bg');
    expect(cssVarName('surfaceHover')).toBe('--color-surface-hover');
    expect(cssVarName('accentText')).toBe('--color-accent-text');
  });

  it('applies every token variable for a mode via the CSSOM (no <style> injection)', () => {
    const target = fakeTarget();
    applyThemeVariables('dark', target);
    expect(target.dataset.theme).toBe('dark');
    for (const name of Object.keys(TOKENS) as TokenName[]) {
      expect(target.props[cssVarName(name)]).toBe(TOKENS[name].dark);
    }
  });

  it('reapplies the OTHER mode\'s values on switch', () => {
    const target = fakeTarget();
    applyThemeVariables('light', target);
    expect(target.props[cssVarName('bg')]).toBe(TOKENS.bg.light);
    applyThemeVariables('dark', target);
    expect(target.props[cssVarName('bg')]).toBe(TOKENS.bg.dark);
  });
});

describe('elevation (mode-aware depth)', () => {
  it('every elevation defines a distinct light and dark shadow', () => {
    for (const name of Object.keys(ELEVATION) as ElevationName[]) {
      const value = ELEVATION[name];
      expect(value.light, `${name}.light`).toMatch(/\S/);
      expect(value.dark, `${name}.dark`).toMatch(/\S/);
      // A dark page needs a heavier cast than a light one; identical values almost
      // always mean the dark tuning was forgotten.
      expect(value.light, `${name} light === dark`).not.toBe(value.dark);
    }
  });

  it('applies elevations via the CSSOM alongside the color tokens', () => {
    const target = fakeTarget();
    applyThemeVariables('dark', target);
    for (const name of Object.keys(ELEVATION) as ElevationName[]) {
      expect(target.props[elevationVarName(name)]).toBe(ELEVATION[name].dark);
    }
  });
});

describe('resolveTheme', () => {
  it('follows the OS when preference is system', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });

  it('lets an explicit preference win over the OS', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });
});
