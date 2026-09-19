// App root. Themed home screen plus the settings view, which the native menu can
// open (Settings / About commands arrive via `onMenuCommand`).

import { useCallback, useEffect, useState } from 'react';
import { token } from './themes/tokens';
import { useTheme } from './themes/ThemeProvider';
import { useAppShortcut } from './hooks/useAppShortcut';
import { SettingsView, type SettingsSectionId } from './features/settings/SettingsView';
import { ProvidersHome } from './features/providers/ProvidersHome';
import { UsageHome } from './features/usage/UsageHome';
import { SkillsHome } from './features/skills/SkillsHome';
import { TitleBar } from './components/TitleBar';
import { MENU_COMMANDS, type MenuCommand } from '../shared/menuCommands';

type View =
  | { name: 'home' }
  | { name: 'usage' }
  | { name: 'skills' }
  | { name: 'settings'; section: SettingsSectionId };

export function App() {
  const { resolved, setPreference } = useTheme();
  const [view, setView] = useState<View>({ name: 'home' });

  // One handler for the menu-command vocabulary, shared by the two entry points:
  // the native OS menu (pushed via `onMenuCommand`, already allowlist-validated in
  // preload) and the in-app title-bar MenuButton. Same commands, same behavior.
  const handleMenuCommand = useCallback((command: MenuCommand) => {
    if (command === MENU_COMMANDS.openSettings) setView({ name: 'settings', section: 'appearance' });
    else if (command === MENU_COMMANDS.showUsage) setView({ name: 'usage' });
    else if (command === MENU_COMMANDS.showSkills) setView({ name: 'skills' });
    else if (command === MENU_COMMANDS.checkForUpdates) setView({ name: 'settings', section: 'updates' });
    else if (command === MENU_COMMANDS.showAbout) setView({ name: 'settings', section: 'about' });
  }, []);

  useEffect(() => window.aiopt.onMenuCommand(handleMenuCommand), [handleMenuCommand]);

  // The rebindable demo shortcut: flip between light and dark. This proves the
  // renderer `useAppShortcut` path end to end (the menu-backed shortcuts prove the
  // native-accelerator path). Setting an explicit preference resolves `system`.
  const toggleTheme = useCallback(
    () => setPreference(resolved === 'dark' ? 'light' : 'dark'),
    [resolved, setPreference],
  );
  useAppShortcut('toggle-theme', toggleTheme);

  // The window is a column: a draggable title strip on top (macOS only; see
  // TitleBar), then the active view fills the rest.
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        background: token('bg'),
        color: token('text'),
      }}
    >
      <TitleBar onCommand={handleMenuCommand} />
      <div style={{ flex: 1, minHeight: 0 }}>
        {view.name === 'settings' ? (
          <SettingsView initialSection={view.section} onClose={() => setView({ name: 'home' })} />
        ) : view.name === 'usage' ? (
          <UsageHome onClose={() => setView({ name: 'home' })} />
        ) : view.name === 'skills' ? (
          <SkillsHome onClose={() => setView({ name: 'home' })} />
        ) : (
          <ProvidersHome />
        )}
      </div>
    </div>
  );
}
