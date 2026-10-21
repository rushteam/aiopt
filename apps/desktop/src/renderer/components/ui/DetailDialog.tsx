// A modal for a selected item's detail (an MCP server, a skill): a fixed header with the
// title and a close button, and a body that scrolls on its own. Opening it from a long list
// keeps the detail in view instead of appending it below the list.
//
// Escape and a backdrop click close it. Callers that stack another dialog on top should
// unmount this one meanwhile (its focus trap would otherwise hold Tab).

import { useEffect, type CSSProperties, type ReactNode } from 'react';
import { elevation, fontSize, radius, space, token } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import { noDragRegion, useModalFocus } from './modal';

export function DetailDialog({
  labelId,
  title,
  closeLabel,
  onClose,
  children,
}: {
  /** id of the heading inside `title`, for aria-labelledby. */
  labelId: string;
  title: ReactNode;
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const panelRef = useModalFocus<HTMLDivElement>();

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelId}
        style={panelStyle}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={headerStyle}>
          <div style={{ flex: 1, minWidth: 0 }}>{title}</div>
          <button
            type="button"
            onClick={onClose}
            aria-label={closeLabel}
            title={closeLabel}
            {...hoverBackground('transparent', token('surfaceHover'))}
            style={closeButtonStyle}
          >
            ×
          </button>
        </div>
        <div style={bodyStyle}>{children}</div>
      </div>
    </div>
  );
}

const overlayStyle: CSSProperties = {
  position: 'fixed',
  ...noDragRegion,
  inset: 0,
  background: token('overlay'),
  display: 'grid',
  placeItems: 'center',
  padding: space['2xl'],
  zIndex: 20,
};

const panelStyle: CSSProperties = {
  width: 'min(760px, 100%)',
  maxHeight: '100%',
  boxSizing: 'border-box',
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
  background: token('bg'),
  color: token('text'),
  border: `1px solid ${token('border')}`,
  borderRadius: radius.xl,
  boxShadow: elevation('modal'),
  outline: 'none',
};

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: space.md,
  flexShrink: 0,
  padding: `${space.xl}px ${space.xl}px ${space.md}px`,
  borderBottom: `1px solid ${token('border')}`,
};

const bodyStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  overscrollBehavior: 'contain',
  padding: `${space.lg}px ${space.xl}px ${space.xl}px`,
};

const closeButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
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
};
