// In-app title-bar menu — a hamburger that opens the SAME renderer-reactive
// commands as the native application menu. The command vocabulary is the single
// source of truth in shared/menuCommands, so this button and the OS menu bar can
// never drift.
//
// Faithfully ported from Cindy's title-bar MenuButton: its reason for existing is
// that a hidden/custom title bar removes the OS menu affordance, so the app needs
// its own always-visible entry point for these commands. It is interactive, so it
// opts out of the window drag region (`no-drag`) inside the draggable strip.

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { elevation, fontSize, radius, space, token } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import { useT } from '../../i18n';
import { MENU_COMMANDS, type MenuCommand } from '../../../shared/menuCommands';

// Omit anything that's already a tab: Usage and Skills are tabs, so they're
// dropped here to avoid a duplicate path. Settings (also reachable via the gear),
// Check for Updates, and About stay — they're not tabs.
const ITEMS: ReadonlyArray<{ command: MenuCommand; labelKey: string }> = [
  { command: MENU_COMMANDS.openSettings, labelKey: 'titleBar.menuItems.settings' },
  { command: MENU_COMMANDS.checkForUpdates, labelKey: 'titleBar.menuItems.checkForUpdates' },
  { command: MENU_COMMANDS.showAbout, labelKey: 'titleBar.menuItems.about' },
];

export function MenuButton({
  onCommand,
  onQuit,
}: {
  onCommand: (command: MenuCommand) => void;
  /** Quit the whole app. Distinct from a MenuCommand: it's an action main performs. */
  onQuit: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

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

  // On open, move focus into the menu (first item) so it's operable by keyboard
  // without a manual Tab — the expected behavior for an aria menu.
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, [open]);

  const select = (command: MenuCommand) => {
    setOpen(false);
    onCommand(command);
  };

  const selectQuit = () => {
    setOpen(false);
    onQuit();
  };

  // Shared style for every menu row (command items + Quit) so they stay identical.
  const itemStyle: CSSProperties = {
    display: 'block',
    width: '100%',
    textAlign: 'left',
    padding: '8px 10px',
    borderRadius: radius.sm,
    border: 'none',
    background: 'transparent',
    color: token('text'),
    cursor: 'pointer',
    fontSize: fontSize.md,
  };

  // Roving focus: Arrow keys cycle through the items, Home/End jump to the ends.
  // Enter/Space activate natively (they're <button>s); Escape closes via the
  // document handler above.
  const onMenuKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
    );
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    else if (e.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % items.length;
    else next = current <= 0 ? items.length - 1 : current - 1;
    items[next]?.focus();
  };

  return (
    <div ref={rootRef} style={{ position: 'relative', WebkitAppRegion: 'no-drag' } as CSSProperties}>
      <button
        type="button"
        aria-label={t('titleBar.menu')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        {...hoverBackground(open ? token('surfaceHover') : 'transparent', token('surfaceHover'))}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: 28,
          width: 28,
          borderRadius: radius.sm,
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
          ref={menuRef}
          role="menu"
          onKeyDown={onMenuKeyDown}
          style={{
            position: 'absolute',
            top: 34,
            left: 0,
            minWidth: 180,
            background: token('surface'),
            border: `1px solid ${token('border')}`,
            borderRadius: radius.md,
            padding: space.xs,
            boxShadow: elevation('menu'),
            zIndex: 50,
          }}
        >
          {ITEMS.map(({ command, labelKey }) => (
            <button
              key={command}
              type="button"
              role="menuitem"
              onClick={() => select(command)}
              {...hoverBackground('transparent', token('surfaceHover'))}
              style={itemStyle}
            >
              {t(labelKey)}
            </button>
          ))}
          {/* Quit sits below a divider — it's an app-level action, not a view command. */}
          <div
            role="separator"
            style={{
              height: 1,
              margin: `${space.xs}px ${space.xs}px`,
              background: token('border'),
            }}
          />
          <button
            type="button"
            role="menuitem"
            onClick={selectQuit}
            {...hoverBackground('transparent', token('surfaceHover'))}
            style={itemStyle}
          >
            {t('titleBar.menuItems.quit')}
          </button>
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
