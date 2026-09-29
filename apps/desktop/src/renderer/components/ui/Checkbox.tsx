import type { CSSProperties, ReactNode } from 'react';
import { fontSize, radius, space, token } from '../../themes/tokens';

export function Checkbox({
  checked,
  onChange,
  disabled = false,
  'aria-label': ariaLabel,
  'aria-describedby': ariaDescribedBy,
  id,
  style,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  'aria-label'?: string;
  'aria-describedby'?: string;
  id?: string;
  style?: CSSProperties;
}) {
  return (
    <button
      id={id}
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      style={{
        ...boxStyle,
        opacity: disabled ? 0.45 : 1,
        cursor: disabled ? 'default' : 'pointer',
        background: checked ? token('accent') : token('bg'),
        borderColor: checked ? token('accent') : token('borderStrong'),
        ...style,
      }}
    >
      {checked && (
        <svg width={12} height={12} viewBox="0 0 12 12" aria-hidden focusable="false">
          <path
            d="M2.5 6.2 4.8 8.5 9.5 3.8"
            fill="none"
            stroke={token('accentText')}
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  );
}

/** Label + checkbox row (Mantine Checkbox layout). */
export function CheckboxField({
  label,
  checked,
  onChange,
  disabled = false,
  title,
  style,
  labelStyle: labelStyleOverride,
}: {
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  title?: string;
  style?: CSSProperties;
  labelStyle?: CSSProperties;
}) {
  return (
    <label
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: space.sm,
        fontSize: fontSize.sm,
        color: disabled ? token('textMuted') : token('text'),
        cursor: disabled ? 'default' : 'pointer',
        ...style,
      }}
    >
      <Checkbox checked={checked} onChange={onChange} disabled={disabled} />
      <span style={labelStyleOverride}>{label}</span>
    </label>
  );
}

const boxStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  width: 16,
  height: 16,
  padding: 0,
  borderRadius: radius.sm,
  border: `1px solid ${token('borderStrong')}`,
};
