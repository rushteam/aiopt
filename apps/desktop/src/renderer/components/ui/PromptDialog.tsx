import { useEffect, useId, useRef, type CSSProperties } from 'react';
import { elevation, fontSize, radius, space, token } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import { controlInputStyle } from './controlStyles';

/** In-app replacement for `window.prompt()` — same shell as {@link ConfirmDialog}. */
export function PromptDialog({
  title,
  message,
  defaultValue = '',
  confirmLabel,
  cancelLabel,
  inputLabel,
  onConfirm,
  onCancel,
  busy = false,
}: {
  title: string;
  message?: string;
  defaultValue?: string;
  confirmLabel: string;
  cancelLabel: string;
  inputLabel?: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [busy, onCancel]);

  function submit(): void {
    if (busy) return;
    onConfirm(inputRef.current?.value ?? '');
  }

  return (
    <div
      style={overlayStyle}
      role="dialog"
      aria-modal="true"
      aria-labelledby="prompt-dialog-title"
      onClick={() => {
        if (!busy) onCancel();
      }}
    >
      <div
        style={panelStyle}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !busy) {
            e.preventDefault();
            submit();
          }
        }}
      >
        <h2 id="prompt-dialog-title" style={{ margin: 0, fontSize: fontSize.xl }}>
          {title}
        </h2>
        {message !== undefined && (
          <p style={{ margin: 0, fontSize: fontSize.base, color: token('textMuted') }}>{message}</p>
        )}
        <label style={fieldStyle} htmlFor={inputId}>
          {inputLabel !== undefined && <span>{inputLabel}</span>}
          <input
            ref={inputRef}
            id={inputId}
            type="text"
            defaultValue={defaultValue}
            disabled={busy}
            style={controlInputStyle}
          />
        </label>
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
            onClick={submit}
            disabled={busy}
            {...hoverBackground(token('accent'), token('accentHover'))}
            style={{
              ...accentStyle,
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

const fieldStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: space.xs,
  fontSize: fontSize.base,
  color: token('textMuted'),
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

const accentStyle: CSSProperties = {
  padding: '6px 14px',
  borderRadius: radius.sm,
  border: `1px solid ${token('accent')}`,
  background: token('accent'),
  color: token('accentText'),
  fontSize: fontSize.base,
};
