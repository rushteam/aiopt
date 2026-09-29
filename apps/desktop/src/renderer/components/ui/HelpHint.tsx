import type { CSSProperties, PointerEvent } from 'react';
import { fontSize, token } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';

export function HelpHint({
  label,
  style,
  onPointerDown,
}: {
  label: string;
  style?: CSSProperties;
  onPointerDown?: (e: PointerEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => {
        e.stopPropagation();
        onPointerDown?.(e);
      }}
      {...hoverBackground('transparent', token('surfaceHover'))}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 20,
        height: 20,
        padding: 0,
        borderRadius: '50%',
        border: `1px solid ${token('borderStrong')}`,
        background: 'transparent',
        color: token('textMuted'),
        fontSize: fontSize.xs,
        fontWeight: 700,
        cursor: 'help',
        lineHeight: 1,
        flexShrink: 0,
        ...style,
      }}
    >
      ?
    </button>
  );
}
