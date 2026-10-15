import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { elevation, fontSize, radius, space, token } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import { placeHelpBubble } from './helpHintPlacement';

/**
 * A "?" that explains the thing next to it. Hover or keyboard focus previews the text;
 * a click pins it open (click again, click elsewhere or press Escape to close). The
 * bubble is portalled to <body> so dialogs and scrolling lists cannot clip it.
 *
 * The click never bubbles: the hint often sits inside a clickable row (e.g. the binding
 * picker), and opening help must not also select that row.
 */
export function HelpHint({
  label,
  style,
  onPointerDown,
}: {
  label: string;
  style?: CSSProperties;
  onPointerDown?: (e: PointerEvent<HTMLButtonElement>) => void;
}) {
  const bubbleId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const open = pinned || previewing;

  // Close a pinned bubble on an outside press or Escape; Escape also ends a preview.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: globalThis.PointerEvent): void => {
      const t = e.target as Node;
      if (buttonRef.current?.contains(t) || bubbleRef.current?.contains(t)) return;
      setPinned(false);
      setPreviewing(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      // Window capture runs before the dialogs' own window-capture Escape handlers
      // (registered later); swallow it so an enclosing dialog does not close too.
      e.stopImmediatePropagation();
      setPinned(false);
      setPreviewing(false);
    };
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  // Measure after render so the bubble's real size decides flipping and clamping.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = (): void => {
      const anchor = buttonRef.current?.getBoundingClientRect();
      const bubble = bubbleRef.current?.getBoundingClientRect();
      if (!anchor || !bubble) return;
      setPos(
        placeHelpBubble(anchor, { width: bubble.width, height: bubble.height }, { width: window.innerWidth, height: window.innerHeight }),
      );
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-describedby={open ? bubbleId : undefined}
        onClick={(e) => {
          e.stopPropagation();
          setPinned((p) => !p);
          setPreviewing(false);
        }}
        onPointerDown={(e) => {
          e.stopPropagation();
          onPointerDown?.(e);
        }}
        onPointerEnter={() => setPreviewing(true)}
        onPointerLeave={() => setPreviewing(false)}
        onFocus={() => setPreviewing(true)}
        onBlur={() => setPreviewing(false)}
        {...hoverBackground(open ? token('surfaceHover') : 'transparent', token('surfaceHover'))}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 20,
          height: 20,
          padding: 0,
          borderRadius: '50%',
          border: `1px solid ${open ? token('accent') : token('borderStrong')}`,
          background: open ? token('surfaceHover') : 'transparent',
          color: open ? token('text') : token('textMuted'),
          fontSize: fontSize.xs,
          fontWeight: 700,
          cursor: 'pointer',
          lineHeight: 1,
          flexShrink: 0,
          ...style,
        }}
      >
        ?
      </button>
      {open &&
        createPortal(
          <div
            ref={bubbleRef}
            id={bubbleId}
            role="tooltip"
            // Keep a press inside the bubble (selecting text) from reaching rows/backdrops.
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            style={{
              ...bubbleStyle,
              top: pos?.top ?? 0,
              left: pos?.left ?? 0,
              // First frame is unmeasured: render invisibly, then place.
              visibility: pos ? 'visible' : 'hidden',
            }}
          >
            {label}
          </div>,
          document.body,
        )}
    </>
  );
}

const bubbleStyle: CSSProperties = {
  position: 'fixed',
  // Above dialogs (10–20) and dropdowns (40), below the title-bar menu (50).
  zIndex: 45,
  maxWidth: 320,
  padding: `${space.sm}px ${space.md}px`,
  borderRadius: radius.md,
  border: `1px solid ${token('border')}`,
  background: token('bg'),
  color: token('text'),
  boxShadow: elevation('menu'),
  fontSize: fontSize.sm,
  fontWeight: 400,
  lineHeight: 1.5,
  textAlign: 'left',
  whiteSpace: 'normal',
  overflowWrap: 'anywhere',
  userSelect: 'text',
};
