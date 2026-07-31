// In-app title-bar menu — a hamburger that opens the SAME renderer-reactive
// commands as the native application menu. The command vocabulary is the single
// source of truth in shared/menuCommands, so this button and the OS menu bar can
// never drift.
//
// Faithfully ported from Cindy's title-bar MenuButton: its reason for existing is
// that a hidden/custom title bar removes the OS menu affordance, so the app needs
// its own always-visible entry point for these commands. It is interactive, so it
// opts out of the window drag region (`no-drag`) inside the draggable strip.

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { token } from '../../themes/tokens';
import { useT } from '../../i18n';
import { MENU_COMMANDS, type MenuCommand } from '../../../shared/menuCommands';

// Ordered to mirror the native App menu: Settings, Check for Updates, About.
const ITEMS: ReadonlyArray<{ command: MenuCommand; labelKey: string }> = [
  { command: MENU_COMMANDS.openSettings, labelKey: 'titleBar.menuItems.settings' },
  { command: MENU_COMMANDS.checkForUpdates, labelKey: 'titleBar.menuItems.checkForUpdates' },
  { command: MENU_COMMANDS.showAbout, labelKey: 'titleBar.menuItems.about' },
];

export function MenuButton({ onCommand }: { onCommand: (command: MenuCommand) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // While open, dismiss on an outside pointer-down or Escape.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const select = (command: MenuCommand) => {
    setOpen(false);
    onCommand(command);
  };

  return (
    <div ref={rootRef} style={{ position: 'relative', WebkitAppRegion: 'no-drag' } as CSSProperties}>
      <button
        type="button"
        aria-label={t('titleBar.menu')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: 28,
          width: 28,
          borderRadius: 6,
          border: 'none',
          background: open ? token('surfaceHover') : 'transparent',
          color: token('textMuted'),
          cursor: 'pointer',
          padding: 0,
        }}
      >
        <HamburgerIcon />
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: 34,
            left: 0,
            minWidth: 180,
            background: token('surface'),
            border: `1px solid ${token('border')}`,
            borderRadius: 8,
            padding: 4,
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.18)',
            zIndex: 50,
          }}
        >
          {ITEMS.map(({ command, labelKey }) => (
            <button
              key={command}
              type="button"
              role="menuitem"
              onClick={() => select(command)}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = token('surfaceHover');
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
              }}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '8px 10px',
                borderRadius: 6,
                border: 'none',
                background: 'transparent',
                color: token('text'),
                cursor: 'pointer',
                fontSize: 14,
              }}
            >
              {t(labelKey)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function HamburgerIcon() {
  // Three-line "menu" glyph — the same affordance as Cindy's lucide `Menu` (15px),
  // drawn inline so the framework carries no icon dependency.
  return (
    <svg
      width={15}
      height={15}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden
    >
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}
