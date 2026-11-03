// Shared bits of the Workbench pane layout: the drag handle between panes and a square icon
// button. Kept apart from the panes so each one stays about its own content.

import { useRef, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { disabledOpacity, radius, token } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';

/**
 * A vertical divider the user drags to resize the pane on `side` of it. Reports the new width
 * (the caller clamps and persists it); arrow keys step it for keyboard users.
 */
export function PaneResizeHandle({
  side,
  width,
  min,
  max,
  label,
  onResize,
}: {
  /** Which pane this handle sizes: the one to its left, or to its right. */
  side: 'left' | 'right';
  width: number;
  min: number;
  max: number;
  label: string;
  onResize: (width: number) => void;
}) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  const lineRef = useRef<HTMLDivElement>(null);
  const highlight = (on: boolean): void => {
    if (lineRef.current) lineRef.current.style.background = on ? token('accent') : 'transparent';
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, width };
    highlight(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    const start = drag.current;
    if (!start) return;
    const dx = e.clientX - start.x;
    onResize(start.width + (side === 'left' ? dx : -dx));
  };
  const end = (e: PointerEvent<HTMLDivElement>): void => {
    if (!drag.current) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    highlight(false);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const grow = (e.key === 'ArrowRight') === (side === 'left');
    onResize(width + (grow ? 16 : -16));
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onPointerEnter={() => highlight(true)}
      onPointerLeave={() => {
        if (!drag.current) highlight(false);
      }}
      onFocus={() => highlight(true)}
      onBlur={() => highlight(false)}
      onKeyDown={onKeyDown}
      style={handleStyle}
    >
      <div ref={lineRef} style={handleLineStyle} />
    </div>
  );
}

/** A square, borderless icon button for pane headers and rails. */
export function IconButton({
  label,
  onClick,
  children,
  active = false,
  disabled = false,
  size = 28,
  expanded,
  style,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  active?: boolean;
  disabled?: boolean;
  size?: number;
  expanded?: boolean;
  style?: CSSProperties;
}) {
  const rest = active ? token('surfaceHover') : 'transparent';
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-expanded={expanded}
      disabled={disabled}
      onClick={onClick}
      {...hoverBackground(rest, token('surfaceHover'))}
      style={{
        display: 'inline-grid',
        placeItems: 'center',
        width: size,
        height: size,
        padding: 0,
        flexShrink: 0,
        border: 'none',
        borderRadius: radius.sm,
        background: rest,
        color: active ? token('text') : token('textMuted'),
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? disabledOpacity : 1,
        ...style,
      }}
    >
      {children}
    </button>
  );
}

// The 1px divider is the pane border; the hit area extends 3px each side over the panes.
const handleStyle: CSSProperties = {
  position: 'relative',
  zIndex: 1,
  flexShrink: 0,
  width: 7,
  margin: '0 -3px',
  cursor: 'col-resize',
  touchAction: 'none',
  outline: 'none',
};

const handleLineStyle: CSSProperties = {
  position: 'absolute',
  top: 0,
  bottom: 0,
  left: 2,
  width: 3,
  borderRadius: radius.pill,
  background: 'transparent',
  transition: 'background 120ms ease',
};
