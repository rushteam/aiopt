// Settings shell — a left-hand section nav plus the active section's panel.
//
// Sections are registered in one array so later stages (account, shortcuts,
// updates) add an entry without touching the layout. The active section can be
// driven externally (e.g. the native menu's "About" command opens this view on
// the About section).

import { useState, type ComponentType } from 'react';
import { token, fontSize, radius, space } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
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
        height: '100%',
        background: token('bg'),
        color: token('text'),
      }}
    >
      <nav
        style={{
          borderRight: `1px solid ${token('border')}`,
          background: token('surface'),
          padding: space.lg,
          display: 'flex',
          flexDirection: 'column',
          gap: space.xs,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <strong style={{ fontSize: fontSize.base, color: token('textMuted') }}>{t('settings.title')}</strong>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('settings.close')}
            {...hoverBackground('transparent', token('surfaceHover'))}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 28,
              height: 28,
              padding: 0,
              borderRadius: radius.sm,
              border: 'none',
              background: 'transparent',
              color: token('textMuted'),
              cursor: 'pointer',
              fontSize: fontSize.xl,
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
              {...hoverBackground(
                selected ? token('surfaceHover') : 'transparent',
                token('surfaceHover'),
              )}
              style={{
                textAlign: 'left',
                padding: '8px 10px',
                borderRadius: radius.sm,
                border: 'none',
                cursor: 'pointer',
                fontSize: fontSize.md,
                fontWeight: selected ? 600 : 400,
                color: selected ? token('accent') : token('text'),
                background: selected ? token('surfaceHover') : 'transparent',
              }}
            >
              {t(`settings.sections.${section.labelKey}`)}
            </button>
          );
        })}
      </nav>
      <div style={{ padding: space['2xl'], overflowY: 'auto' }}>
        <ActivePanel />
      </div>
    </div>
  );
}
