// App root. Themed home screen plus the settings view, which the native menu can
// open (Settings / About commands arrive via `onMenuCommand`).

import { useCallback, useEffect, useState } from 'react';
import { token } from './themes/tokens';
import { useTheme } from './themes/ThemeProvider';
import { useAppShortcut } from './hooks/useAppShortcut';
import { useT } from './i18n';
import { SettingsView, type SettingsSectionId } from './features/settings/SettingsView';
import { TitleBar } from './components/TitleBar';
import { MENU_COMMANDS, type MenuCommand } from '../shared/menuCommands';

type View = { name: 'home' } | { name: 'settings'; section: SettingsSectionId };

export function App() {
  const t = useT();
  const { resolved, setPreference } = useTheme();
  const [view, setView] = useState<View>({ name: 'home' });

  // One handler for the menu-command vocabulary, shared by the two entry points:
  // the native OS menu (pushed via `onMenuCommand`, already allowlist-validated in
  // preload) and the in-app title-bar MenuButton. Same commands, same behavior.
  const handleMenuCommand = useCallback((command: MenuCommand) => {
    if (command === MENU_COMMANDS.openSettings) setView({ name: 'settings', section: 'appearance' });
    else if (command === MENU_COMMANDS.checkForUpdates) setView({ name: 'settings', section: 'updates' });
    else if (command === MENU_COMMANDS.showAbout) setView({ name: 'settings', section: 'about' });
  }, []);

  useEffect(() => window.hearth.onMenuCommand(handleMenuCommand), [handleMenuCommand]);

  // The rebindable demo shortcut: flip between light and dark. This proves the
  // renderer `useAppShortcut` path end to end (the menu-backed shortcuts prove the
  // native-accelerator path). Setting an explicit preference resolves `system`.
  const toggleTheme = useCallback(
    () => setPreference(resolved === 'dark' ? 'light' : 'dark'),
    [resolved, setPreference],
  );
  useAppShortcut('toggle-theme', toggleTheme);

  const { platform, versions } = window.hearth;

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
        ) : (
          <main
            style={{
              fontFamily: 'system-ui, sans-serif',
              display: 'grid',
              placeItems: 'center',
              height: '100%',
            }}
          >
            <div style={{ textAlign: 'center' }}>
              <h1 style={{ margin: '0 0 8px' }}>Hearth</h1>
              <p style={{ margin: '0 0 20px' }}>{t('app.tagline')}</p>
              <button
                type="button"
                onClick={() => setView({ name: 'settings', section: 'appearance' })}
                style={{
                  padding: '8px 16px',
                  borderRadius: 8,
                  border: `1px solid ${token('border')}`,
                  background: token('surface'),
                  color: token('text'),
                  cursor: 'pointer',
                  fontSize: 14,
                }}
              >
                {t('nav.settings')}
              </button>
              <p style={{ opacity: 0.6, fontSize: 13, marginTop: 20 }}>
                {platform} · Electron {versions.electron} · Chrome {versions.chrome}
              </p>
            </div>
          </main>
        )}
      </div>
    </div>
  );
}
