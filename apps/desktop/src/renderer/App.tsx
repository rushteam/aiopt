// App root. A top tab bar switches between the three peer screens (Providers /
// Skills / Usage); a gear on that bar toggles the Settings surface, which floats
// above the active tab rather than replacing it. The native menu can also drive
// both (Settings / Usage / Skills / About commands arrive via `onMenuCommand`).

import { useCallback, useEffect, useState } from 'react';
import { token } from './themes/tokens';
import { useTheme } from './themes/ThemeProvider';
import { useAppShortcut } from './hooks/useAppShortcut';
import { SettingsView, type SettingsSectionId } from './features/settings/SettingsView';
import { ProvidersHome } from './features/providers/ProvidersHome';
import { UsageHome } from './features/usage/UsageHome';
import { SkillsHome } from './features/skills/SkillsHome';
import { TitleBar } from './components/TitleBar';
import { type AppTab } from './components/TabBar';
import { MENU_COMMANDS, type MenuCommand } from '../shared/menuCommands';

export function App() {
  const { resolved, setPreference } = useTheme();
  const [tab, setTab] = useState<AppTab>('providers');
  // Settings floats above the active tab. `null` = closed; otherwise the section
  // to show. It's a separate axis from `tab` so closing Settings returns you to
  // wherever you were, not to a fixed "home".
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId | null>(null);

  // One handler for the menu-command vocabulary, shared by the two entry points:
  // the native OS menu (pushed via `onMenuCommand`, already allowlist-validated in
  // preload) and the in-app title-bar MenuButton. Same commands, same behavior.
  const handleMenuCommand = useCallback((command: MenuCommand) => {
    if (command === MENU_COMMANDS.openSettings) setSettingsSection('general');
    else if (command === MENU_COMMANDS.showUsage) {
      setSettingsSection(null);
      setTab('usage');
    } else if (command === MENU_COMMANDS.showSkills) {
      setSettingsSection(null);
      setTab('skills');
    } else if (command === MENU_COMMANDS.checkForUpdates) setSettingsSection('updates');
    else if (command === MENU_COMMANDS.showAbout) setSettingsSection('about');
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

  const settingsOpen = settingsSection !== null;

  // The window is a column: the top bar (tabs + settings gear, plus the macOS
  // hamburger) on one row, then the active screen fills the rest.
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
      <TitleBar
        onCommand={handleMenuCommand}
        tab={tab}
        onSelectTab={(next) => {
          setSettingsSection(null);
          setTab(next);
        }}
        settingsOpen={settingsOpen}
      />
      <div style={{ flex: 1, minHeight: 0 }}>
        {settingsSection !== null ? (
          <SettingsView initialSection={settingsSection} onClose={() => setSettingsSection(null)} />
        ) : tab === 'usage' ? (
          <UsageHome />
        ) : tab === 'skills' ? (
          <SkillsHome />
        ) : (
          <ProvidersHome />
        )}
      </div>
    </div>
  );
}
