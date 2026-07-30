// ThemeProvider — owns the theme preference and keeps the document's
// `data-theme` attribute in sync with it.
//
// The preference is persisted in the MAIN process (layered config store), so:
//   • the initial value is read synchronously via the preload bridge to avoid a
//     flash of the wrong theme,
//   • changes are written back through `config.set` and echoed to every window
//     via the `config:changed` push, which we subscribe to,
//   • when the preference is `system`, we track the OS via `matchMedia`.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { ThemePreference } from '../../shared/ipc-channels';
import { applyThemeVariables, type ResolvedTheme } from './tokens';
import { resolveTheme } from './resolveTheme';

interface ThemeContextValue {
  /** The user's stored choice. */
  preference: ThemePreference;
  /** The concrete theme currently applied (system resolved against the OS). */
  resolved: ResolvedTheme;
  /** Persist a new preference (optimistically applied, then confirmed by push). */
  setPreference: (next: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const DARK_QUERY = '(prefers-color-scheme: dark)';

function systemPrefersDark(): boolean {
  return typeof matchMedia === 'function' && matchMedia(DARK_QUERY).matches;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPref] = useState<ThemePreference>(() => window.hearth.theme.getInitial());
  const [systemDark, setSystemDark] = useState<boolean>(systemPrefersDark);

  // Track the OS color scheme (only affects the UI while preference is `system`).
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia(DARK_QUERY);
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // Reflect preference changes pushed from main (e.g. another window changed it).
  useEffect(() => window.hearth.config.onChanged((prefs) => setPref(prefs.theme)), []);

  const resolved = resolveTheme(preference, systemDark);

  // Apply the resolved token values (CSSOM, CSP-safe) so all `var(--color-*)`
  // references re-resolve for the new mode.
  useEffect(() => {
    applyThemeVariables(resolved);
  }, [resolved]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPref(next); // optimistic; the config:changed echo will confirm
    void window.hearth.config.set('theme', next);
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ preference, resolved, setPreference }),
    [preference, resolved, setPreference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}
