// The explorer's right-click menu. Drawn in the renderer (like the title-bar MenuButton): it
// only picks an action — every file operation is still a named IPC call main validates.
// Opens at the pointer, clamped to the window; dismissed by an outside pointer-down, Escape,
// blur, or picking an item. Arrow keys / Home / End move between items.

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { disabledOpacity, elevation, fontSize, radius, space, token } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';

export type ContextMenuItem =
  | { kind: 'item'; label: string; onSelect: () => void; disabled?: boolean; danger?: boolean; hint?: string }
  | { kind: 'separator' };

const MARGIN = 4;

export function ExplorerContextMenu({
  x,
  y,
  label,
  items,
  onClose,
}: {
  x: number;
  y: number;
  label: string;
  items: readonly ContextMenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Keep the whole menu inside the window (flip up / left near the edges).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const left = x + width + MARGIN > window.innerWidth ? Math.max(MARGIN, x - width) : x;
    const top = y + height + MARGIN > window.innerHeight ? Math.max(MARGIN, y - height) : y;
    setPos({ left, top });
  }, [x, y]);

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
    const onPointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  const onMenuKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const list = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);
    if (list.length === 0) return;
    const cur = list.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? list.length - 1
          : e.key === 'ArrowDown'
            ? (cur + 1) % list.length
            : cur <= 0
              ? list.length - 1
              : cur - 1;
    list[next]?.focus();
  };

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      onKeyDown={onMenuKeyDown}
      onContextMenu={(e) => e.preventDefault()}
      style={{ ...menuStyle, left: pos.left, top: pos.top }}
    >
      {items.map((item, i) =>
        item.kind === 'separator' ? (
          <div key={`sep-${i}`} role="separator" style={separatorStyle} />
        ) : (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
            {...hoverBackground('transparent', token('surfaceHover'))}
            style={{
              ...itemStyle,
              color: item.danger ? token('danger') : token('text'),
              opacity: item.disabled ? disabledOpacity : 1,
              cursor: item.disabled ? 'default' : 'pointer',
            }}
          >
            <span style={{ flex: 1, minWidth: 0 }}>{item.label}</span>
            {item.hint && <span style={hintStyle}>{item.hint}</span>}
          </button>
        ),
      )}
    </div>
  );
}

const menuStyle: CSSProperties = {
  position: 'fixed',
  minWidth: 200,
  maxWidth: 320,
  background: token('surface'),
  border: `1px solid ${token('border')}`,
  borderRadius: radius.md,
  padding: space.xs,
  boxShadow: elevation('menu'),
  zIndex: 60,
};

const itemStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: space.lg,
  width: '100%',
  textAlign: 'left',
  padding: '5px 10px',
  borderRadius: radius.sm,
  border: 'none',
  background: 'transparent',
  fontSize: fontSize.base,
  whiteSpace: 'nowrap',
};

const hintStyle: CSSProperties = { flexShrink: 0, fontSize: fontSize.xs, color: token('textMuted') };

const separatorStyle: CSSProperties = { height: 1, margin: `${space.xs}px ${space.xs}px`, background: token('border') };
