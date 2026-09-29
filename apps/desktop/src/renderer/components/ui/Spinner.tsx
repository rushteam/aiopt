import type { CSSProperties } from 'react';
import type { ControlSize } from './controlStyles';

const SPINNER_PX: Record<ControlSize, number> = { sm: 14, md: 16 };

/** Accent ring spinner — animation in global.css (`aiopt-spinner`). */
export function Spinner({
  size = 'md',
  style,
  label,
}: {
  size?: ControlSize;
  style?: CSSProperties;
  /** When set, exposed to assistive tech (otherwise decorative). */
  label?: string;
}) {
  const px = SPINNER_PX[size];
  return (
    <span
      className="aiopt-spinner"
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ width: px, height: px, flexShrink: 0, ...style }}
    />
  );
}
