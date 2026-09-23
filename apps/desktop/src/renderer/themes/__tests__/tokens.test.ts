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

/**
 * Relative luminance / contrast ratio per WCAG 2.x. Small enough to inline, and
 * inlining it keeps the gate free of a dependency.
 */
function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const channel = (i: number): number => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

describe('contrast (WCAG)', () => {
  // 1.4.11 Non-text Contrast: a UI component's visual boundary needs 3:1 against
  // its adjacent background. `borderStrong` is the token that carries that job for
  // every custom <button>/<input>/switch — those have no fill, so the outline IS
  // the affordance. `border` is exempt: it draws dividers, which are decoration.
  it('borderStrong clears 3:1 on every background a control can sit on', () => {
    const grounds = ['bg', 'surface', 'surfaceHover'] as const;
    for (const mode of ['light', 'dark'] as const) {
      for (const ground of grounds) {
        const ratio = contrast(TOKENS.borderStrong[mode], TOKENS[ground][mode]);
        expect(ratio, `borderStrong on ${ground} (${mode}) = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  // The switch fills its OFF track with borderStrong and its thumb with `bg`, so the
  // thumb-vs-track edge is what conveys on/off. It is a state indicator, so it needs
  // the same 3:1.
  it('the switch thumb clears 3:1 against its off track', () => {
    for (const mode of ['light', 'dark'] as const) {
      const ratio = contrast(TOKENS.bg[mode], TOKENS.borderStrong[mode]);
      expect(ratio, `bg on borderStrong (${mode}) = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
    }
  });

  // 1.4.3 Contrast (Minimum) for the text tokens actually used as body/secondary copy.
  it('text and textMuted clear 4.5:1 on every surface they are set on', () => {
    for (const mode of ['light', 'dark'] as const) {
      for (const fg of ['text', 'textMuted'] as const) {
        for (const ground of ['bg', 'surface', 'surfaceHover'] as const) {
          const ratio = contrast(TOKENS[fg][mode], TOKENS[ground][mode]);
          expect(ratio, `${fg} on ${ground} (${mode}) = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
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
