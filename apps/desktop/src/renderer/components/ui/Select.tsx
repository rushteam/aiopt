import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { disabledOpacity, elevation, fontSize, radius, space, token } from '../../themes/tokens';
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
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0, maxHeight: LIST_MAX_HEIGHT });
  // Only keyboard moves scroll the list to the highlighted row. Pointer hover must never
  // scroll it: the row under the cursor is already visible, and scrolling on hover is what
  // made a wheel-scrolled list jump back.
  const scrollToHighlight = useRef(false);

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
    // The list is fixed-positioned against the trigger's rect at open time. If anything
    // behind it scrolls (the dialog body) or the window resizes, that rect is stale and
    // the list would float detached, so close it. Scrolling the list itself is fine.
    const onScroll = (e: Event): void => {
      if (listRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onResize = (): void => setOpen(false);
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  // On open only (not on every render — `selectable` is a fresh array each time, and
  // re-running this on hover reset the highlight and scrolled the list back to the
  // selected row): highlight the current value and bring it into view once.
  useLayoutEffect(() => {
    if (!open) return;
    const idx = selectable.findIndex((e) => e.option.value === value);
    setHighlight(idx >= 0 ? idx : 0);
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open-time snapshot by design
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !scrollToHighlight.current) return;
    scrollToHighlight.current = false;
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [open, highlight]);

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
    // Open below when it fits, otherwise on the side with more room, sized to that room.
    const below = window.innerHeight - margin - (rect.bottom + 4);
    const above = rect.top - 4 - margin;
    const flipUp = below < LIST_MAX_HEIGHT && above > below;
    const maxHeight = Math.max(120, Math.min(LIST_MAX_HEIGHT, flipUp ? above : below));
    const top = flipUp ? Math.max(margin, rect.top - 4 - maxHeight) : rect.bottom + 4;
    setPos({ top, left, width: listWidth, maxHeight });
    setOpen(true);
  }

  function pick(next: string): void {
    onChange(next);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function onTriggerKeyDown(e: ReactKeyboardEvent<HTMLButtonElement>): void {
    if (disabled) return;
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      openList();
    } else if (open && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      if (highlight >= 0 && selectable[highlight]) pick(selectable[highlight].option.value);
    } else if (e.key === 'ArrowUp' && open) {
      e.preventDefault();
      scrollToHighlight.current = true;
      setHighlight((h) => (h <= 0 ? selectable.length - 1 : h - 1));
    } else if (e.key === 'ArrowDown' && open) {
      e.preventDefault();
      scrollToHighlight.current = true;
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
          opacity: disabled ? disabledOpacity : 1,
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
              maxHeight: pos.maxHeight,
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
                      opacity: entry.option.disabled ? disabledOpacity : 1,
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

const LIST_MAX_HEIGHT = 320;

const listStyle: CSSProperties = {
  position: 'fixed',
  zIndex: 40,
  overflowY: 'auto',
  // Reaching either end of the list must not scroll the dialog behind it.
  overscrollBehavior: 'contain',
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
