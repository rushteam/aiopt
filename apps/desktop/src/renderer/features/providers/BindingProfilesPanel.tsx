import { useEffect, useState } from 'react';
import { token, fontSize, radius, space } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import { useT } from '../../i18n';
import type { BindingProfileSummary } from '../../../shared/bindingProfiles';
import {
  applyBindingProfile,
  deleteBindingProfile,
  listBindingProfiles,
  saveBindingProfile,
} from '../../lib/providerStore';
import { providerErrorMessage } from './errors';

export function BindingProfilesPanel() {
  const t = useT();
  const [profiles, setProfiles] = useState<BindingProfileSummary[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    try {
      setProfiles(await listBindingProfiles());
    } catch (err) {
      setError(providerErrorMessage(t, err));
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  async function onSave(): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      setProfiles(await saveBindingProfile(trimmed));
      setName('');
    } catch (err) {
      setError(providerErrorMessage(t, err));
    } finally {
      setBusy(false);
    }
  }

  async function onApply(id: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await applyBindingProfile(id);
    } catch (err) {
      setError(providerErrorMessage(t, err));
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(id: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setProfiles(await deleteBindingProfile(id));
    } catch (err) {
      setError(providerErrorMessage(t, err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section style={{ marginBottom: 32 }}>
      <h2 style={headingStyle}>{t('providers.profiles.heading')}</h2>
      <p style={{ margin: `0 0 ${space.md}px`, fontSize: fontSize.sm, color: token('textMuted') }}>
        {t('providers.profiles.hint')}
      </p>
      {error && (
        <p role="alert" style={{ margin: `0 0 ${space.sm}px`, color: token('danger'), fontSize: fontSize.sm }}>
          {error}
        </p>
      )}
      <div style={{ display: 'flex', gap: space.sm, flexWrap: 'wrap', marginBottom: space.md }}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('providers.profiles.namePlaceholder')}
          aria-label={t('providers.profiles.namePlaceholder')}
          disabled={busy}
          style={inputStyle}
        />
        <button
          type="button"
          disabled={busy || name.trim() === ''}
          onClick={() => void onSave()}
          {...hoverBackground(token('accent'), token('accentHover'))}
          style={saveBtnStyle}
        >
          {t('providers.profiles.save')}
        </button>
      </div>
      {profiles.length === 0 ? (
        <p style={{ margin: 0, fontSize: fontSize.sm, color: token('textMuted') }}>{t('providers.profiles.empty')}</p>
      ) : (
        <ul style={listStyle}>
          {profiles.map((p) => (
            <li key={p.id} style={rowStyle}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: fontSize.base }}>{p.name}</div>
                <div style={{ fontSize: fontSize.sm, color: token('textMuted') }}>
                  {t('providers.profiles.boundCount').replace('{{count}}', String(p.boundCount))}
                </div>
              </div>
              <div style={{ display: 'flex', gap: space.sm, flexShrink: 0 }}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void onApply(p.id)}
                  {...hoverBackground('transparent', token('surfaceHover'))}
                  style={ghostBtn}
                >
                  {t('providers.profiles.apply')}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void onDelete(p.id)}
                  {...hoverBackground('transparent', token('surfaceHover'))}
                  style={ghostBtn}
                >
                  {t('providers.profiles.delete')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const headingStyle = {
  margin: '0 0 12px',
  fontSize: fontSize['2xl'],
  fontWeight: 600,
} as const;

const inputStyle = {
  flex: '1 1 160px',
  minWidth: 140,
  padding: '8px 10px',
  borderRadius: radius.sm,
  border: `1px solid ${token('borderStrong')}`,
  background: token('bg'),
  color: token('text'),
  fontSize: fontSize.md,
} as const;

const saveBtnStyle = {
  padding: '6px 12px',
  borderRadius: radius.sm,
  border: `1px solid ${token('accent')}`,
  background: token('accent'),
  color: token('accentText'),
  fontSize: fontSize.sm,
  cursor: 'pointer',
} as const;

const listStyle = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: space.sm,
} as const;

const rowStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: space.md,
  flexWrap: 'wrap',
  padding: '10px 12px',
  borderRadius: radius.md,
  border: `1px solid ${token('border')}`,
  background: token('surface'),
} as const;

const ghostBtn = {
  padding: '4px 10px',
  borderRadius: radius.sm,
  border: `1px solid ${token('borderStrong')}`,
  background: 'transparent',
  color: token('text'),
  fontSize: fontSize.sm,
  cursor: 'pointer',
} as const;
