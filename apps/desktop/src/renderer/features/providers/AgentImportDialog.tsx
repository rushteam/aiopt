import { useEffect, useState, type CSSProperties } from 'react';
import { disabledOpacity, elevation, token, fontSize, radius, space } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import { useT } from '../../i18n';
import type { AgentImportCandidate } from '../../../shared/agentImport';
import { addAgentImportProvider, scanAgentImports } from '../../lib/providerStore';
import { agentImportErrorMessage, isAgentImportBridgeStale } from './errors';

export function AgentImportDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [candidates, setCandidates] = useState<AgentImportCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanErrorIsInfo, setScanErrorIsInfo] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    setLoading(true);
    setScanError(null);
    setScanErrorIsInfo(false);
    try {
      setCandidates(await scanAgentImports());
    } catch (err) {
      setScanErrorIsInfo(isAgentImportBridgeStale(err));
      setScanError(agentImportErrorMessage(t, err));
      setCandidates([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && busyId === null) onClose();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose, busyId]);

  async function onImport(agentId: AgentImportCandidate['agentId']): Promise<void> {
    setBusyId(agentId);
    setImportError(null);
    try {
      await addAgentImportProvider(agentId);
      onClose();
    } catch (err) {
      setImportError(agentImportErrorMessage(t, err));
    } finally {
      setBusyId(null);
    }
  }

  const rescanDisabled = loading || busyId !== null;

  return (
    <div style={overlayStyle} role="dialog" aria-modal="true" onClick={() => busyId === null && onClose()}>
      <div style={panelStyle} onClick={(e) => e.stopPropagation()}>
        <div style={headerStyle}>
          <h2 style={titleStyle}>{t('providers.import.heading')}</h2>
          <div style={headerActionsStyle}>
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={rescanDisabled}
              {...hoverBackground('transparent', token('surfaceHover'))}
              style={{
                ...ghostBtn,
                opacity: rescanDisabled ? disabledOpacity : 1,
                cursor: rescanDisabled ? 'default' : 'pointer',
              }}
            >
              {loading ? t('providers.import.scanning') : t('providers.import.rescan')}
            </button>
            <button
              type="button"
              onClick={onClose}
              disabled={busyId !== null}
              aria-label={t('providers.form.close')}
              title={t('providers.form.close')}
              {...hoverBackground('transparent', token('surfaceHover'))}
              style={closeButtonStyle}
            >
              ×
            </button>
          </div>
        </div>
        {scanError && (
          <p
            role="alert"
            style={{
              ...noticeStyle,
              color: scanErrorIsInfo ? token('textMuted') : token('danger'),
              borderColor: scanErrorIsInfo ? token('borderStrong') : token('danger'),
              background: scanErrorIsInfo ? token('surface') : undefined,
            }}
          >
            {scanError}
          </p>
        )}
        {importError && (
          <p role="alert" style={{ ...noticeStyle, color: token('danger'), borderColor: token('danger') }}>
            {importError}
          </p>
        )}
        {loading ? (
          <p style={{ margin: 0, fontSize: fontSize.sm, color: token('textMuted') }}>
            {t('providers.import.scanning')}
          </p>
        ) : candidates.length === 0 && !scanError ? (
          <p style={{ margin: 0, fontSize: fontSize.sm, color: token('textMuted') }}>
            {t('providers.import.empty')}
          </p>
        ) : (
          <ul style={listStyle}>
            {candidates.map((c) => {
              const isBusy = busyId === c.agentId;
              return (
                <li key={c.agentId} style={rowStyle}>
                  <div style={rowTextStyle}>
                    <span style={agentNameStyle}>{c.agentName}</span>
                    <span style={statusStyle}>
                      {c.available
                        ? t('providers.import.signedIn').replace(
                            '{{account}}',
                            c.accountLabel ?? t('providers.card.oauthAccountUnknown'),
                          )
                        : t(`providers.import.reason.${c.reason ?? 'not_signed_in'}`)}
                    </span>
                  </div>
                  <button
                    type="button"
                    disabled={!c.available || busyId !== null}
                    onClick={() => void onImport(c.agentId)}
                    {...(c.available
                      ? hoverBackground(token('accent'), token('accentHover'))
                      : hoverBackground('transparent', token('surfaceHover')))}
                    style={importBtnStyle(c.available, isBusy)}
                  >
                    {isBusy ? t('providers.import.adding') : t('providers.import.add')}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function importBtnStyle(available: boolean, busy: boolean): CSSProperties {
  if (available) {
    return {
      ...actionBtnBase,
      border: `1px solid ${token('accent')}`,
      background: token('accent'),
      color: token('accentText'),
      cursor: busy ? 'default' : 'pointer',
      opacity: busy ? 0.7 : 1,
    };
  }
  return {
    ...actionBtnBase,
    border: `1px solid ${token('borderStrong')}`,
    background: 'transparent',
    color: token('textMuted'),
    cursor: 'default',
    opacity: disabledOpacity,
  };
}

const overlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: token('overlay'),
  display: 'grid',
  placeItems: 'center',
  padding: space['2xl'],
  zIndex: 20,
};

const panelStyle: CSSProperties = {
  width: 'min(520px, 100%)',
  maxHeight: '100%',
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: space.md,
  background: token('bg'),
  color: token('text'),
  border: `1px solid ${token('border')}`,
  borderRadius: radius.xl,
  boxShadow: elevation('modal'),
  padding: 20,
};

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: space.md,
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: fontSize.xl,
  fontWeight: 600,
  flex: 1,
  minWidth: 0,
  lineHeight: 1.35,
};

const headerActionsStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: space.xs,
  flexShrink: 0,
};

const noticeStyle: CSSProperties = {
  margin: 0,
  padding: '8px 10px',
  fontSize: fontSize.sm,
  lineHeight: 1.45,
  borderRadius: radius.md,
  border: `1px solid ${token('borderStrong')}`,
};

const closeButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  width: 28,
  height: 28,
  padding: 0,
  borderRadius: radius.sm,
  border: 'none',
  background: 'transparent',
  color: token('textMuted'),
  cursor: 'pointer',
  fontSize: fontSize.xl,
  lineHeight: 1,
};

const ghostBtn: CSSProperties = {
  padding: '5px 10px',
  borderRadius: radius.sm,
  border: `1px solid ${token('borderStrong')}`,
  background: 'transparent',
  color: token('text'),
  fontSize: fontSize.sm,
  whiteSpace: 'nowrap',
};

const listStyle: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: space.sm,
};

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: space.md,
  flexWrap: 'wrap',
  padding: '10px 12px',
  borderRadius: radius.md,
  border: `1px solid ${token('border')}`,
  background: token('surface'),
};

const rowTextStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  minWidth: 0,
};

const agentNameStyle: CSSProperties = {
  fontSize: fontSize.base,
  fontWeight: 600,
};

const statusStyle: CSSProperties = {
  fontSize: fontSize.sm,
  color: token('textMuted'),
};

const actionBtnBase: CSSProperties = {
  padding: '5px 12px',
  borderRadius: radius.sm,
  fontSize: fontSize.base,
  whiteSpace: 'nowrap',
  flexShrink: 0,
};
