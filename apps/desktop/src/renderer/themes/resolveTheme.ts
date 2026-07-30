// Pure theme resolution — kept free of React and the DOM so it unit-tests
// directly. `system` follows the OS; an explicit preference wins over it.

import type { ThemePreference } from '../../shared/ipc-channels';
import type { ResolvedTheme } from './tokens';

export function resolveTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (preference === 'system') return systemPrefersDark ? 'dark' : 'light';
  return preference;
}
