import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { elevation, fontSize, radius, space, token } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import { useT } from '../../i18n';
import {
  DEFAULT_BINDING_PROFILE_NAME,
  type BindingProfileSummary,
} from '../../../shared/bindingProfiles';
import {
  applyBindingProfile,
  deleteBindingProfile,
  listBindingProfiles,
  saveBindingProfile,
} from '../../lib/providerStore';
import { providerErrorMessage } from './errors';
import { Select } from '../../components/ui/Select';
import { PromptDialog } from '../../components/ui/PromptDialog';

/** Select value when no saved `default` profile exists yet — live bindings on disk. */
const LIVE_DEFAULT = '__live_default__';

export function BindingProfileSwitcher() {
  const t = useT();
  const [profiles, setProfiles] = useState<BindingProfileSummary[]>([]);
  const [selected, setSelected] = useState<string>(LIVE_DEFAULT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const savedDefault = profiles.find((p) => p.name === DEFAULT_BINDING_PROFILE_NAME);

  async function refresh(): Promise<void> {
    try {
      const next = await listBindingProfiles();
      setProfiles(next);
      const def = next.find((p) => p.name === DEFAULT_BINDING_PROFILE_NAME);
      setSelected((prev) => {
        if (prev !== LIVE_DEFAULT && next.some((p) => p.id === prev)) return prev;
        return def?.id ?? LIVE_DEFAULT;
      });
    } catch (err) {
      setError(providerErrorMessage(t, err));
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: PointerEvent): void => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || menuBtnRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  async function onSelect(value: string): Promise<void> {
    if (value === LIVE_DEFAULT || value === selected) return;
    setBusy(true);
    setError(null);
    try {
      await applyBindingProfile(value);
      setSelected(value);
    } catch (err) {
      setError(providerErrorMessage(t, err));
    } finally {
      setBusy(false);
    }
  }

  async function saveDefault(): Promise<void> {
    setBusy(true);
    setError(null);
    setMenuOpen(false);
    try {
      const next = await saveBindingProfile(DEFAULT_BINDING_PROFILE_NAME);
      setProfiles(next);
      const def = next.find((p) => p.name === DEFAULT_BINDING_PROFILE_NAME);
      if (def) setSelected(def.id);
    } catch (err) {
      setError(providerErrorMessage(t, err));
    } finally {
      setBusy(false);
    }
  }

  function saveAsNew(): void {
    setMenuOpen(false);
    setSaveAsOpen(true);
  }

  async function confirmSaveAs(name: string): Promise<void> {
    setSaveAsOpen(false);
    const trimmed = name.trim();
    if (trimmed === '') return;
    setBusy(true);
    setError(null);
    try {
      const next = await saveBindingProfile(trimmed);
      setProfiles(next);
      const created = next.find((p) => p.name === trimmed);
      if (created) setSelected(created.id);
    } catch (err) {
      setError(providerErrorMessage(t, err));
    } finally {
      setBusy(false);
    }
  }

  async function onDeleteSelected(): Promise<void> {
    if (selected === LIVE_DEFAULT) return;
    setMenuOpen(false);
    setBusy(true);
    setError(null);
    try {
      const next = await deleteBindingProfile(selected);
      setProfiles(next);
      const def = next.find((p) => p.name === DEFAULT_BINDING_PROFILE_NAME);
      setSelected(def?.id ?? LIVE_DEFAULT);
    } catch (err) {
      setError(providerErrorMessage(t, err));
    } finally {
      setBusy(false);
    }
  }

  function openMenu(): void {
    const rect = menuBtnRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 200;
    const margin = 8;
    let left = rect.right - width;
    left = Math.min(left, window.innerWidth - width - margin);
    setMenuPos({
      top: rect.bottom + 4,
      left: Math.max(margin, left),
    });
    setMenuOpen(true);
  }

  const canDelete = selected !== LIVE_DEFAULT;

  return (
    <div style={rootStyle}>
      <label id="binding-profile-select-label" style={labelStyle} htmlFor="binding-profile-select">
        {t('providers.profiles.switchLabel')}
      </label>
      <Select
        id="binding-profile-select"
        value={selected}
        disabled={busy}
        size="sm"
        style={{ maxWidth: 200, minWidth: 112, flex: '1 1 112px' }}
        aria-labelledby="binding-profile-select-label"
        onChange={(value) => void onSelect(value)}
        options={[
          ...(!savedDefault
            ? [{ value: LIVE_DEFAULT, label: t('providers.profiles.defaultLive') }]
            : []),
          ...profiles.map((p) => ({ value: p.id, label: p.name })),
        ]}
      />
      <button
        ref={menuBtnRef}
        type="button"
        disabled={busy}
        aria-label={t('providers.profiles.menuAria')}
        aria-expanded={menuOpen}
        onClick={() => (menuOpen ? setMenuOpen(false) : openMenu())}
        {...hoverBackground('transparent', token('surfaceHover'))}
        style={menuBtnStyle}
      >
        ⋯
      </button>
      {error && (
        <span id="binding-profile-error" role="alert" style={errorStyle}>
          {error}
        </span>
      )}
      {saveAsOpen && (
        <PromptDialog
          title={t('providers.profiles.menuSaveAs')}
          inputLabel={t('providers.profiles.saveAsPrompt')}
          defaultValue=""
          confirmLabel={t('providers.profiles.save')}
          cancelLabel={t('providers.form.cancel')}
          busy={busy}
          onCancel={() => setSaveAsOpen(false)}
          onConfirm={(value) => void confirmSaveAs(value)}
        />
      )}
      {menuOpen &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            style={{
              ...menuStyle,
              top: menuPos.top,
              left: menuPos.left,
            }}
          >
            <MenuItem disabled={busy} onClick={() => void saveDefault()}>
              {t('providers.profiles.menuSaveDefault')}
            </MenuItem>
            <MenuItem disabled={busy} onClick={() => void saveAsNew()}>
              {t('providers.profiles.menuSaveAs')}
            </MenuItem>
            <MenuItem disabled={busy || !canDelete} onClick={() => void onDeleteSelected()}>
              {t('providers.profiles.menuDelete')}
            </MenuItem>
          </div>,
          document.body,
        )}
    </div>
  );
}

function MenuItem({
  children,
  disabled,
  onClick,
}: {
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      {...hoverBackground('transparent', token('surfaceHover'))}
      style={{
        ...menuItemStyle,
        opacity: disabled ? 0.45 : 1,
        cursor: disabled ? 'default' : 'pointer',
      }}
    >
      {children}
    </button>
  );
}

const rootStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  justifyContent: 'flex-end',
  gap: space.xs,
  flexShrink: 0,
  maxWidth: '100%',
};

const labelStyle: CSSProperties = {
  fontSize: fontSize.sm,
  color: token('textMuted'),
  whiteSpace: 'nowrap',
};

const menuBtnStyle: CSSProperties = {
  width: 28,
  height: 28,
  padding: 0,
  borderRadius: radius.sm,
  border: `1px solid ${token('borderStrong')}`,
  background: 'transparent',
  color: token('textMuted'),
  cursor: 'pointer',
  fontSize: fontSize.lg,
  lineHeight: 1,
};

const errorStyle: CSSProperties = {
  width: '100%',
  textAlign: 'right',
  fontSize: fontSize.xs,
  color: token('danger'),
};

const menuStyle: CSSProperties = {
  position: 'fixed',
  zIndex: 30,
  minWidth: 200,
  padding: space.xs,
  borderRadius: radius.md,
  border: `1px solid ${token('border')}`,
  background: token('bg'),
  boxShadow: elevation('menu'),
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
};

const menuItemStyle: CSSProperties = {
  width: '100%',
  textAlign: 'left',
  padding: '6px 10px',
  borderRadius: radius.sm,
  border: 'none',
  background: 'transparent',
  color: token('text'),
  fontSize: fontSize.sm,
};
