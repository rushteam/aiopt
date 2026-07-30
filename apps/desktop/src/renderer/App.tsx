// App root. Themed home screen plus the settings view, which the native menu can
// open (Settings / About commands arrive via `onMenuCommand`).

import { useEffect, useState } from 'react';
import { token } from './themes/tokens';
import { useT } from './i18n';
import { SettingsView, type SettingsSectionId } from './features/settings/SettingsView';
import { MENU_COMMANDS } from '../shared/menuCommands';

type View = { name: 'home' } | { name: 'settings'; section: SettingsSectionId };

export function App() {
  const t = useT();
  const [view, setView] = useState<View>({ name: 'home' });

  // React to native-menu commands (already allowlist-validated in preload).
  useEffect(
    () =>
      window.hearth.onMenuCommand((command) => {
        if (command === MENU_COMMANDS.openSettings) setView({ name: 'settings', section: 'appearance' });
        else if (command === MENU_COMMANDS.showAbout) setView({ name: 'settings', section: 'about' });
      }),
    [],
  );

  if (view.name === 'settings') {
    return <SettingsView initialSection={view.section} onClose={() => setView({ name: 'home' })} />;
  }

  const { platform, versions } = window.hearth;
  return (
    <main
      style={{
        fontFamily: 'system-ui, sans-serif',
        display: 'grid',
        placeItems: 'center',
        height: '100vh',
        margin: 0,
        background: token('bg'),
        color: token('text'),
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
  );
}
