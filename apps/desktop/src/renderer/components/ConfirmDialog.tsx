// A modal confirmation for destructive, hard-to-reverse actions (delete a
// provider, clear usage history). It replaces the older in-place pattern where a
// button rewrote itself into a "Confirm / Cancel" row: a modal pulls focus, dims
// the rest, and can't be dismissed by an accidental click elsewhere, which is what
// a destructive action warrants.
//
// The overlay / panel idiom mirrors ProviderFormDialog (same overlay token, same
// modal elevation) so the app has one dialog look. Escape and an overlay-backdrop
// click both cancel — the conventional "dismiss" gestures — while a click inside
// the panel is swallowed so it never bubbles to the backdrop and closes.

import { useEffect, type CSSProperties, type ReactNode } from 'react';
import { elevation, token, fontSize, radius, space } from '../themes/tokens';
import { hoverBackground } from '../lib/hover';

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  danger = false,
  busy = false,
}: {
  title: string;
  /** Optional supporting line under the title; string or custom node. */
  message?: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** Style the confirm button as destructive (filled danger). */
  danger?: boolean;
  /** Disable both buttons while the confirmed action is in flight. */
  busy?: boolean;
}) {
  // Escape cancels, matching the backdrop click. Registered while mounted only.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [busy, onCancel]);

  return (
    <div
      style={overlayStyle}
      role="dialog"
      aria-modal="true"
      // A click on the backdrop (not the panel) cancels — but never while busy.
      onClick={() => {
        if (!busy) onCancel();
      }}
    >
      <div style={panelStyle} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: 0, fontSize: fontSize.xl }}>{title}</h2>
        {message !== undefined && (
          <p style={{ margin: 0, fontSize: fontSize.base, color: token('textMuted') }}>{message}</p>
        )}
        <div style={actionsStyle}>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            {...hoverBackground('transparent', token('surfaceHover'))}
            style={{ ...ghostStyle, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.5 : 1 }}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            {...(danger
              ? hoverBackground(token('danger'), token('dangerHover'))
              : hoverBackground('transparent', token('surfaceHover')))}
            style={{
              ...(danger ? dangerSolidStyle : ghostStyle),
              cursor: busy ? 'default' : 'pointer',
              opacity: busy ? 0.5 : 1,
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

const overlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: token('overlay'),
  display: 'grid',
  placeItems: 'center',
  padding: space['2xl'],
  zIndex: 20,
};

const panelStyle: CSSProperties = {
  width: 'min(420px, 100%)',
  display: 'flex',
  flexDirection: 'column',
  gap: space.lg,
  background: token('bg'),
  color: token('text'),
  border: `1px solid ${token('border')}`,
  borderRadius: radius.xl,
  boxShadow: elevation('modal'),
  padding: 20,
};

const actionsStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: space.md,
};

const ghostStyle: CSSProperties = {
  padding: '6px 14px',
  borderRadius: radius.sm,
  border: `1px solid ${token('borderStrong')}`,
  background: 'transparent',
  color: token('text'),
  fontSize: fontSize.base,
};

const dangerSolidStyle: CSSProperties = {
  padding: '6px 14px',
  borderRadius: radius.sm,
  border: `1px solid ${token('danger')}`,
  background: token('danger'),
  color: token('accentText'),
  fontSize: fontSize.base,
};
