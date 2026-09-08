// One provider in the global pool: identity, format badge, endpoint, key status,
// model count, and edit / delete actions.
//
// Delete is a destructive, hard-to-reverse action (it drops the stored key too), so
// it takes a second, inline confirmation rather than firing on the first click.

import { useState } from 'react';
import { token, fontSize, radius, space } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import { useT } from '../../i18n';
import type { ProviderSummary } from '../../../shared/ipc-channels';
import { removeProvider } from '../../lib/providerStore';
import { providerErrorMessage } from './errors';

export function ProviderCard({
  provider,
  onEdit,
}: {
  provider: ProviderSummary;
  onEdit: () => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [hoverDelete, setHoverDelete] = useState(false);

  async function onDelete(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await removeProvider(provider.id);
      // Success unmounts this card; no state reset needed.
    } catch (err) {
      setError(providerErrorMessage(t, err));
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: space.md }}>
        <strong style={{ fontSize: fontSize.lg }}>{provider.name}</strong>
        <span style={badgeStyle}>{t(`providers.formats.${provider.apiFormat}`)}</span>
      </div>
      <p style={metaStyle}>{provider.baseUrl}</p>
      <p style={metaStyle}>
        {t('providers.card.models')}: {provider.models.length} ·{' '}
        {provider.hasKey ? t('providers.card.keySet') : t('providers.card.keyMissing')}
      </p>
      {error && (
        <p role="alert" style={{ margin: 0, color: token('danger'), fontSize: fontSize.sm }}>
          {error}
        </p>
      )}

      {confirming ? (
        <div style={confirmRowStyle}>
          <span style={{ fontSize: fontSize.base, color: token('danger'), marginRight: 'auto' }}>
            {t('providers.card.confirmDelete')}
          </span>
          <button
            type="button"
            onClick={() => void onDelete()}
            disabled={busy}
            {...hoverBackground(token('danger'), token('dangerHover'))}
            style={dangerSolidStyle}
          >
            {t('providers.card.confirmYes')}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            disabled={busy}
            {...hoverBackground('transparent', token('surfaceHover'))}
            style={actionStyle('ghost')}
          >
            {t('providers.form.cancel')}
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: space.md, marginTop: 4 }}>
          <button
            type="button"
            onClick={onEdit}
            disabled={busy}
            {...hoverBackground('transparent', token('surfaceHover'))}
            style={actionStyle('ghost')}
          >
            {t('providers.card.edit')}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={busy}
            onMouseEnter={() => setHoverDelete(true)}
            onMouseLeave={() => setHoverDelete(false)}
            style={deleteButtonStyle(hoverDelete)}
          >
            <TrashIcon />
            {t('providers.card.delete')}
          </button>
        </div>
      )}
    </div>
  );
}

const cardStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: space.sm,
  padding: 14,
  borderRadius: radius.lg,
  border: `1px solid ${token('border')}`,
  background: token('surface'),
} as const;

const badgeStyle = {
  fontSize: fontSize.xs,
  padding: '2px 8px',
  borderRadius: radius.pill,
  border: `1px solid ${token('border')}`,
  color: token('textMuted'),
} as const;

const metaStyle = { margin: 0, fontSize: fontSize.base, color: token('textMuted') } as const;

const confirmRowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: space.md,
  marginTop: 4,
} as const;

function actionStyle(kind: 'ghost' | 'danger') {
  return {
    padding: '5px 12px',
    borderRadius: radius.sm,
    border: `1px solid ${kind === 'danger' ? token('danger') : token('border')}`,
    background: 'transparent',
    color: kind === 'danger' ? token('danger') : token('text'),
    cursor: 'pointer',
    fontSize: fontSize.base,
  } as const;
}

// Subtle by default, fills danger on hover — reads as "careful" without shouting.
function deleteButtonStyle(hover: boolean) {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: space.sm,
    padding: '5px 12px',
    borderRadius: radius.sm,
    border: `1px solid ${hover ? token('danger') : token('border')}`,
    background: hover ? token('danger') : 'transparent',
    color: hover ? token('accentText') : token('textMuted'),
    cursor: 'pointer',
    fontSize: fontSize.base,
  } as const;
}

// Trash glyph for the delete action — an SVG (not an emoji) so it renders
// identically across platforms and follows currentColor in both themes.
function TrashIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 6h18" />
      <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M6 6l1 14a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-14" />
    </svg>
  );
}

const dangerSolidStyle = {
  padding: '5px 12px',
  borderRadius: radius.sm,
  border: `1px solid ${token('danger')}`,
  background: token('danger'),
  color: token('accentText'),
  cursor: 'pointer',
  fontSize: fontSize.base,
} as const;
