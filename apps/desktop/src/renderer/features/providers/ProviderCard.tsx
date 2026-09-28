// One provider in the global pool: identity, format badge, endpoint, key status,
// model count, and edit / delete actions.
//
// Delete is a destructive, hard-to-reverse action (it drops the stored key too), so
// it takes a second confirmation in a modal dialog rather than firing on the first
// click.

import { useState } from 'react';
import { token, fontSize, radius, space } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import { useT } from '../../i18n';
import type { ProviderSummary } from '../../../shared/ipc-channels';
import {
  oauthDisconnectProvider,
  oauthStartProvider,
  removeProvider,
  testProvider,
} from '../../lib/providerStore';
import type { ProviderTestResult } from '../../../shared/ipc-channels';
import { ConfirmDialog } from '../../components/ConfirmDialog';
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
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ProviderTestResult | null>(null);
  const [oauthBusy, setOauthBusy] = useState(false);
  const isOAuth = provider.credentialMode === 'oauth';
  const isAgentImport = provider.credentialMode === 'agent_import';
  const sessionBacked = isOAuth || isAgentImport;

  async function onTest(): Promise<void> {
    if (provider.virtual) return;
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await testProvider(provider.id));
    } catch {
      setTestResult({ ok: false, latencyMs: null, format: null, error: 'upstream' });
    } finally {
      setTesting(false);
    }
  }

  async function onOAuthConnect(): Promise<void> {
    setOauthBusy(true);
    setError(null);
    try {
      await oauthStartProvider(provider.id);
    } catch (err) {
      setError(providerErrorMessage(t, err));
    } finally {
      setOauthBusy(false);
    }
  }

  async function onOAuthDisconnect(): Promise<void> {
    setOauthBusy(true);
    setError(null);
    try {
      await oauthDisconnectProvider(provider.id);
    } catch (err) {
      setError(providerErrorMessage(t, err));
    } finally {
      setOauthBusy(false);
    }
  }

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

  const confirmDialog = confirming ? (
    <ConfirmDialog
      title={t('providers.card.confirmDelete')}
      confirmLabel={t('providers.card.confirmYes')}
      cancelLabel={t('providers.form.cancel')}
      danger
      busy={busy}
      onConfirm={() => void onDelete()}
      onCancel={() => setConfirming(false)}
    />
  ) : null;

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: space.md }}>
        <strong style={{ fontSize: fontSize.lg }}>{provider.name}</strong>
        {/* One badge per served format — a gateway that speaks several shows them all. */}
        <span style={{ display: 'flex', flexWrap: 'wrap', gap: space.xs }}>
          {provider.apiFormats.map((format) => (
            <span key={format} style={badgeStyle}>
              {t(`providers.formats.${format}`)}
            </span>
          ))}
        </span>
      </div>
      {!provider.virtual && <p style={metaStyle}>{provider.baseUrl}</p>}
      {provider.virtual && (
        <p style={metaStyle}>{t('providers.combined.description')}</p>
      )}
      <p style={metaStyle}>
        {t('providers.card.models')}: {provider.models.length}
        {sessionBacked ? (
          <>
            {' · '}
            {provider.hasKey
              ? t('providers.card.oauthConnected').replace(
                  '{{account}}',
                  provider.oauthAccountLabel?.trim() || t('providers.card.oauthAccountUnknown'),
                )
              : t('providers.card.oauthDisconnected')}
          </>
        ) : (
          <>
            {' · '}
            {provider.hasKey ? t('providers.card.keySet') : t('providers.card.keyMissing')}
          </>
        )}
      </p>
      {error && (
        <p role="alert" style={{ margin: 0, color: token('danger'), fontSize: fontSize.sm }}>
          {error}
        </p>
      )}
      {testResult && (
        <p
          style={{
            margin: 0,
            fontSize: fontSize.sm,
            color: testResult.ok ? token('text') : token('danger'),
          }}
        >
          {testResult.ok
            ? t('providers.card.testOk')
                .replace('{{ms}}', String(testResult.latencyMs ?? 0))
                .replace(
                  '{{format}}',
                  testResult.format ? t(`providers.formats.${testResult.format}`) : '',
                )
            : t(`providers.card.testErrors.${testResult.error ?? 'upstream'}`)}
        </p>
      )}

      <div style={{ display: 'flex', gap: space.md, marginTop: 4, flexWrap: 'wrap' }}>
        {!provider.virtual && (
          <>
            <button
              type="button"
              onClick={onEdit}
              disabled={busy}
              {...hoverBackground('transparent', token('surfaceHover'))}
              style={actionStyle('ghost')}
            >
              {t('providers.card.edit')}
            </button>
            {isOAuth && (
              <button
                type="button"
                onClick={() => void (provider.hasKey ? onOAuthDisconnect() : onOAuthConnect())}
                disabled={busy || oauthBusy}
                {...hoverBackground('transparent', token('surfaceHover'))}
                style={actionStyle('ghost')}
              >
                {oauthBusy
                  ? t('providers.card.oauthBusy')
                  : provider.hasKey
                    ? t('providers.card.oauthDisconnect')
                    : t('providers.card.oauthConnect')}
              </button>
            )}
            {isAgentImport && (
              <span style={{ fontSize: fontSize.sm, color: token('textMuted') }}>
                {t('providers.card.agentImportHint')}
              </span>
            )}
            <button
              type="button"
              onClick={() => void onTest()}
              disabled={busy || testing || (sessionBacked && !provider.hasKey)}
              {...hoverBackground('transparent', token('surfaceHover'))}
              style={actionStyle('ghost')}
            >
              {testing ? t('providers.card.testing') : t('providers.card.test')}
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
          </>
        )}
      </div>
      {confirmDialog}
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

// Only the ghost variant is used now (Edit); the danger variant is kept for a
// consistent call site should another inline action need it.
function actionStyle(kind: 'ghost' | 'danger') {
  return {
    padding: '5px 12px',
    borderRadius: radius.sm,
    border: `1px solid ${kind === 'danger' ? token('danger') : token('borderStrong')}`,
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
    border: `1px solid ${hover ? token('danger') : token('borderStrong')}`,
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
