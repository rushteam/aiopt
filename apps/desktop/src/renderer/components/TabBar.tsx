// Top-level navigation — the three peer screens (Providers / Skills / Usage) as
// tabs. It replaces the old per-screen "×" close buttons, so there's one
// consistent navigation model instead of three screens that each felt modal.
// Settings lives in the hamburger menu (and the OS menu bar), not here; selecting
// a tab is how you leave the Settings surface.
//
// This is the INNER content of the top bar: TitleBar owns the bar chrome (height,
// border, drag region, traffic-light inset) and embeds this so the tabs sit on the
// same row as the macOS hamburger. Each tab opts out of the window drag region
// (`no-drag`); the empty space after the tabs stays draggable on macOS.

import type { CSSProperties } from 'react';
import { fontSize, space, token } from '../themes/tokens';
import { useT } from '../i18n';

export type AppTab = 'providers' | 'skills' | 'usage';

// Reuse the already-decided screen titles as tab labels — no new glossary terms.
const TABS: ReadonlyArray<{ id: AppTab; labelKey: string }> = [
  { id: 'providers', labelKey: 'providers.title' },
  { id: 'skills', labelKey: 'skills.title' },
  { id: 'usage', labelKey: 'usage.title' },
];

const noDrag = { WebkitAppRegion: 'no-drag' } as CSSProperties;

export function TabBar({
  active,
  onSelect,
  settingsOpen,
}: {
  active: AppTab;
  onSelect: (tab: AppTab) => void;
  /** When Settings is showing, no tab is the active page (selecting one leaves it). */
  settingsOpen: boolean;
}) {
  const t = useT();
  return (
    <div style={{ display: 'flex', flex: 1, minWidth: 0, alignItems: 'stretch' }}>
      <div style={{ display: 'flex', alignItems: 'stretch', gap: space.md }}>
        {TABS.map((tab) => {
          // The active tab reads at full `accent` with an underline; the rest recede
          // to `textMuted` and lift to `text` on hover (color carries the state, not a
          // filled background — restrained, matching the rest of the chrome).
          const selected = tab.id === active && !settingsOpen;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onSelect(tab.id)}
              aria-current={selected ? 'page' : undefined}
              style={{
                ...noDrag,
                display: 'inline-flex',
                alignItems: 'center',
                padding: '0 4px',
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                fontSize: fontSize.md,
                fontWeight: selected ? 600 : 400,
                color: selected ? token('accent') : token('textMuted'),
                // A 2px accent rule along the bottom of the active tab, sitting on top
                // of the bar's own bottom border so it reads as a selected underline.
                boxShadow: selected ? `inset 0 -2px 0 0 ${token('accent')}` : 'none',
              }}
              onMouseEnter={(e) => {
                if (!selected) e.currentTarget.style.color = token('text');
              }}
              onMouseLeave={(e) => {
                if (!selected) e.currentTarget.style.color = token('textMuted');
              }}
            >
              {t(tab.labelKey)}
            </button>
          );
        })}
      </div>
    </div>
  );
}
