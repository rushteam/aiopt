import type { CSSProperties, ReactNode } from 'react';
import { disabledOpacity, space, token } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import {
  buttonAccentChrome,
  buttonGhostChrome,
  type ControlSize,
} from './controlStyles';
import { Spinner } from './Spinner';

type Variant = 'accent' | 'ghost';

export function LoadingButton({
  variant,
  size = 'md',
  loading = false,
  disabled = false,
  children,
  loadingLabel,
  onClick,
  style,
  type = 'button',
  'aria-label': ariaLabel,
}: {
  variant: Variant;
  size?: ControlSize;
  loading?: boolean;
  disabled?: boolean;
  children: ReactNode;
  /** Shown beside the spinner while `loading`; defaults to `children`. */
  loadingLabel?: string;
  onClick?: () => void;
  style?: CSSProperties;
  type?: 'button' | 'submit';
  'aria-label'?: string;
}) {
  const inactive = disabled || loading;
  const chrome = variant === 'accent' ? buttonAccentChrome(size) : buttonGhostChrome(size);
  const hover =
    variant === 'accent'
      ? hoverBackground(token('accent'), token('accentHover'))
      : hoverBackground('transparent', token('surfaceHover'));

  return (
    <button
      type={type}
      aria-label={ariaLabel}
      aria-busy={loading || undefined}
      disabled={inactive}
      onClick={onClick}
      {...(inactive ? {} : hover)}
      style={{
        ...chrome,
        gap: space.sm,
        opacity: disabled && !loading ? disabledOpacity : 1,
        cursor: inactive ? 'default' : 'pointer',
        ...style,
      }}
    >
      {loading && <Spinner size={size} />}
      <span style={{ whiteSpace: 'nowrap' }}>
        {loading && loadingLabel !== undefined ? loadingLabel : children}
      </span>
    </button>
  );
}
