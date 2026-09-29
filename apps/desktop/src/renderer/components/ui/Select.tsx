import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { elevation, fontSize, radius, space, token } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import { controlInputSmStyle, controlInputStyle } from './controlStyles';

export type SelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

export type SelectGroup = {
  label: string;
  options: readonly SelectOption[];
};

type FlatEntry =
  | { kind: 'option'; option: SelectOption }
  | { kind: 'group'; label: string; option: SelectOption };

function flattenEntries(
  options: readonly SelectOption[] | undefined,
  groups: readonly SelectGroup[] | undefined,
): FlatEntry[] {
  const out: FlatEntry[] = [];
  for (const o of options ?? []) out.push({ kind: 'option', option: o });
  for (const g of groups ?? []) {
    for (const o of g.options) out.push({ kind: 'group', label: g.label, option: o });
  }
  return out;
}

export function Select({
  value,
  onChange,
  options,
  groups,
  disabled = false,
  size = 'md',
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  id,
  style,
}: {
  value: string;
  onChange: (value: string) => void;
  options?: readonly SelectOption[];
  groups?: readonly SelectGroup[];
  disabled?: boolean;
  size?: 'sm' | 'md';
  'aria-label'?: string;
  'aria-labelledby'?: string;
  id?: string;
  style?: CSSProperties;
}) {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0 });

  const entries = flattenEntries(options, groups);
  const selectable = entries.filter((e) => !e.option.disabled);
  const selected = entries.find((e) => e.option.value === value)?.option;
  const displayLabel = selected?.label ?? value;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent): void => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t) || listRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const idx = selectable.findIndex((e) => e.option.value === value);
    setHighlight(idx >= 0 ? idx : 0);
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [open, selectable, value]);

  function openList(): void {
    if (disabled) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const margin = 8;
    const listWidth = Math.max(rect.width, 200);
    let left = rect.left;
    if (left + listWidth > window.innerWidth - margin) {
      left = window.innerWidth - listWidth - margin;
    }
    left = Math.max(margin, left);
    let top = rect.bottom + 4;
    const maxHeight = 280;
    if (top + maxHeight > window.innerHeight - margin) {
      top = Math.max(margin, rect.top - 4 - Math.min(maxHeight, 240));
    }
    setPos({ top, left, width: listWidth });
    setOpen(true);
  }

  function pick(next: string): void {
    onChange(next);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function onTriggerKeyDown(e: ReactKeyboardEvent<HTMLButtonElement>): void {
    if (disabled) return;
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!open) openList();
      else if (e.key === 'Enter' && highlight >= 0) pick(selectable[highlight]!.option.value);
    } else if (e.key === 'ArrowUp' && open) {
      e.preventDefault();
      setHighlight((h) => (h <= 0 ? selectable.length - 1 : h - 1));
    } else if (e.key === 'ArrowDown' && open) {
      e.preventDefault();
      setHighlight((h) => (h + 1) % selectable.length);
    }
  }

  const triggerBase = size === 'sm' ? controlInputSmStyle : controlInputStyle;

  let lastGroup = '';

  return (
    <div ref={rootRef} style={{ position: 'relative', minWidth: 0, ...style }}>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onTriggerKeyDown}
        {...hoverBackground(token('surface'), token('surfaceHover'))}
        style={{
          ...triggerBase,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: space.sm,
          textAlign: 'left',
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.55 : 1,
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayLabel}</span>
        <Chevron open={open} />
      </button>
      {open &&
        createPortal(
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={ariaLabel}
            style={{
              ...listStyle,
              top: pos.top,
              left: pos.left,
              width: Math.max(pos.width, 160),
            }}
          >
            {entries.map((entry, i) => {
              const showGroupHeader = entry.kind === 'group' && entry.label !== lastGroup;
              if (entry.kind === 'group') lastGroup = entry.label;
              const selIdx = selectable.findIndex((s) => s.option.value === entry.option.value);
              const isHighlighted = selIdx === highlight;
              const isSelected = entry.option.value === value;
              return (
                <div key={`${entry.option.value}-${i}`}>
                  {showGroupHeader && <div style={groupLabelStyle}>{entry.label}</div>}
                  <button
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    data-active={isHighlighted ? 'true' : undefined}
                    disabled={entry.option.disabled}
                    onMouseEnter={() => {
                      if (selIdx >= 0) setHighlight(selIdx);
                    }}
                    onClick={() => pick(entry.option.value)}
                    style={{
                      ...optionStyle,
                      background: isHighlighted ? token('surfaceHover') : isSelected ? token('surface') : 'transparent',
                      opacity: entry.option.disabled ? 0.45 : 1,
                      cursor: entry.option.disabled ? 'default' : 'pointer',
                    }}
                  >
                    <span style={{ flex: 1, textAlign: 'left' }}>{entry.option.label}</span>
                    {isSelected && (
                      <svg width={14} height={14} viewBox="0 0 14 14" aria-hidden style={{ flexShrink: 0 }}>
                        <path
                          d="M3 7.2 5.8 10 11 4.5"
                          fill="none"
                          stroke={token('accent')}
                          strokeWidth="1.6"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    )}
                  </button>
                </div>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 14 14"
      aria-hidden
      style={{ flexShrink: 0, opacity: 0.65, transform: open ? 'rotate(180deg)' : undefined, transition: 'transform 120ms ease' }}
    >
      <path d="M3.5 5.5 7 9 10.5 5.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const listStyle: CSSProperties = {
  position: 'fixed',
  zIndex: 40,
  maxHeight: 280,
  overflow: 'auto',
  padding: space.xs,
  borderRadius: radius.md,
  border: `1px solid ${token('border')}`,
  background: token('bg'),
  boxShadow: elevation('menu'),
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
};

const groupLabelStyle: CSSProperties = {
  padding: '6px 10px 4px',
  fontSize: fontSize.xs,
  fontWeight: 600,
  color: token('textMuted'),
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
};

const optionStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: space.sm,
  width: '100%',
  padding: '8px 10px',
  borderRadius: radius.sm,
  border: 'none',
  color: token('text'),
  fontSize: fontSize.sm,
};
