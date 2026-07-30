// Settings shell — a left-hand section nav plus the active section's panel.
//
// Sections are registered in one array so later stages (account, shortcuts,
// updates) add an entry without touching the layout. The active section can be
// driven externally (e.g. the native menu's "About" command opens this view on
// the About section).

import { useState, type ComponentType } from 'react';
import { token } from '../../themes/tokens';
import { useT } from '../../i18n';
import { AppearanceSection } from './AppearanceSection';
import { AccountSection } from './AccountSection';
import { ShortcutsSection } from './ShortcutsSection';
import { UpdateSection } from './UpdateSection';
import { AboutSection } from './AboutSection';

export type SettingsSectionId = 'appearance' | 'account' | 'shortcuts' | 'updates' | 'about';

interface SectionDef {
  id: SettingsSectionId;
  /** i18n key under `settings.sections`. */
  labelKey: string;
  Component: ComponentType;
}

const SECTIONS = [
  { id: 'appearance', labelKey: 'appearance', Component: AppearanceSection },
  { id: 'account', labelKey: 'account', Component: AccountSection },
  { id: 'shortcuts', labelKey: 'shortcuts', Component: ShortcutsSection },
  { id: 'updates', labelKey: 'updates', Component: UpdateSection },
  { id: 'about', labelKey: 'about', Component: AboutSection },
] as const satisfies readonly SectionDef[];

const DEFAULT_SECTION = SECTIONS[0];

export function SettingsView({
  initialSection = 'appearance',
  onClose,
}: {
  initialSection?: SettingsSectionId;
  onClose: () => void;
}) {
  const t = useT();
  const [active, setActive] = useState<SettingsSectionId>(initialSection);
  const ActivePanel = (SECTIONS.find((s) => s.id === active) ?? DEFAULT_SECTION).Component;

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '200px 1fr',
        height: '100vh',
        background: token('bg'),
        color: token('text'),
      }}
    >
      <nav
        style={{
          borderRight: `1px solid ${token('border')}`,
          background: token('surface'),
          padding: 12,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <strong style={{ fontSize: 13, color: token('textMuted') }}>{t('settings.title')}</strong>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('settings.close')}
            style={{
              border: 'none',
              background: 'transparent',
              color: token('textMuted'),
              cursor: 'pointer',
              fontSize: 16,
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>
        {SECTIONS.map((section) => {
          const selected = section.id === active;
          return (
            <button
              key={section.id}
              type="button"
              onClick={() => setActive(section.id)}
              style={{
                textAlign: 'left',
                padding: '8px 10px',
                borderRadius: 6,
                border: 'none',
                cursor: 'pointer',
                fontSize: 14,
                color: token('text'),
                background: selected ? token('surfaceHover') : 'transparent',
              }}
            >
              {t(`settings.sections.${section.labelKey}`)}
            </button>
          );
        })}
      </nav>
      <div style={{ padding: 24, overflowY: 'auto' }}>
        <ActivePanel />
      </div>
    </div>
  );
}
