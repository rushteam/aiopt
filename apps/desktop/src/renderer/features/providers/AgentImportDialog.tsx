import { useEffect, useState, type CSSProperties } from 'react';
import { disabledOpacity, elevation, token, fontSize, radius, space } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import { useT } from '../../i18n';
import type { AgentImportCandidate } from '../../../shared/agentImport';
import { addAgentImportProvider, scanAgentImports } from '../../lib/providerStore';
import { agentImportErrorMessage, isAgentImportBridgeStale } from './errors';
import { noDragRegion, useModalFocus } from '../../components/ui/modal';
import { groupImportCandidates } from './agentImportGroups';

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
      // A stale list (added elsewhere meanwhile) — rescan so the row shows "Added".
      void refresh();
    } finally {
      setBusyId(null);
    }
  }

  const rescanDisabled = loading || busyId !== null;
  const panelRef = useModalFocus<HTMLDivElement>();
  const groups = groupImportCandidates(candidates);
  const [showUnavailable, setShowUnavailable] = useState(false);
  // Nothing to import: the unavailable list is the whole answer, so show it open.
  const unavailableOpen = showUnavailable || (groups.ready.length === 0 && groups.added.length === 0);

  const renderRow = (c: AgentImportCandidate, index: number) => {
    const isBusy = busyId === c.agentId;
    const canAdd = c.available && !c.alreadyAdded;
    return (
      <li key={c.agentId} style={index === 0 ? { ...rowStyle, borderTop: 'none' } : rowStyle}>
        <div style={rowTextStyle}>
          <span style={agentNameStyle}>{c.agentName}</span>
          {c.available && (
            <span style={statusStyle}>
              {t('providers.import.signedIn').replace(
                '{{account}}',
                c.accountLabel ?? t('providers.card.oauthAccountUnknown'),
              )}
            </span>
          )}
        </div>
        {canAdd ? (
          <button
            type="button"
            disabled={busyId !== null}
            onClick={() => void onImport(c.agentId)}
            {...hoverBackground(token('accent'), token('accentHover'))}
            style={importBtnStyle(isBusy)}
          >
            {isBusy ? t('providers.import.adding') : t('providers.import.add')}
          </button>
        ) : (
          <span style={rowStateStyle}>
            {c.alreadyAdded
              ? t('providers.import.added')
              : t(`providers.import.reason.${c.reason ?? 'not_signed_in'}`)}
          </span>
        )}
      </li>
    );
  };

  return (
    <div style={overlayStyle} onClick={() => busyId === null && onClose()}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-import-title"
        style={panelStyle}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={headerStyle}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 id="agent-import-title" style={titleStyle}>
              {t('providers.import.heading')}
            </h2>
            {!loading && candidates.length > 0 && (
              <p style={summaryStyle}>
                {t('providers.import.summary')
                  .replace('{{ready}}', String(groups.ready.length))
                  .replace('{{total}}', String(candidates.length))}
              </p>
            )}
          </div>
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
        <div style={bodyStyle}>
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
            <p style={mutedLineStyle}>{t('providers.import.scanning')}</p>
          ) : candidates.length === 0 && !scanError ? (
            <p style={mutedLineStyle}>{t('providers.import.empty')}</p>
          ) : (
            <>
              {groups.ready.length > 0 && (
                <section aria-label={t('providers.import.sectionReady')}>
                  <h3 style={sectionHeadingStyle}>{t('providers.import.sectionReady')}</h3>
                  <ul style={listStyle}>{groups.ready.map(renderRow)}</ul>
                </section>
              )}
              {groups.added.length > 0 && (
                <section aria-label={t('providers.import.sectionAdded')}>
                  <h3 style={sectionHeadingStyle}>{t('providers.import.sectionAdded')}</h3>
                  <ul style={listStyle}>{groups.added.map(renderRow)}</ul>
                </section>
              )}
              {groups.unavailable.length > 0 && (
                <section aria-label={t('providers.import.sectionUnavailable')}>
                  <button
                    type="button"
                    aria-expanded={unavailableOpen}
                    onClick={() => setShowUnavailable(!unavailableOpen)}
                    {...hoverBackground('transparent', token('surfaceHover'))}
                    style={disclosureStyle}
                  >
                    <span aria-hidden style={{ display: 'inline-block', width: 10 }}>
                      {unavailableOpen ? '▾' : '▸'}
                    </span>
                    {t('providers.import.sectionUnavailable').concat(` · ${groups.unavailable.length}`)}
                  </button>
                  {unavailableOpen && <ul style={listStyle}>{groups.unavailable.map(renderRow)}</ul>}
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function importBtnStyle(busy: boolean): CSSProperties {
  return {
    ...actionBtnBase,
    border: `1px solid ${token('accent')}`,
    background: token('accent'),
    color: token('accentText'),
    cursor: busy ? 'default' : 'pointer',
    opacity: busy ? 0.7 : 1,
  };
}

const overlayStyle: CSSProperties = {
  position: 'fixed',
  ...noDragRegion,
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
  boxSizing: 'border-box',
  // Header stays put; only the body scrolls (see bodyStyle).
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
  background: token('bg'),
  color: token('text'),
  border: `1px solid ${token('border')}`,
  borderRadius: radius.xl,
  boxShadow: elevation('modal'),
  outline: 'none',
};

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: space.md,
  flexShrink: 0,
  padding: `${space.xl}px ${space.xl}px ${space.md}px`,
  borderBottom: `1px solid ${token('border')}`,
};

const bodyStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  // Keep the wheel inside the dialog at the ends of the list.
  overscrollBehavior: 'contain',
  display: 'flex',
  flexDirection: 'column',
  gap: space.lg,
  padding: `${space.md}px ${space.xl}px ${space.xl}px`,
};

const summaryStyle: CSSProperties = {
  margin: `${space.xs}px 0 0`,
  fontSize: fontSize.sm,
  color: token('textMuted'),
};

const mutedLineStyle: CSSProperties = { margin: 0, fontSize: fontSize.sm, color: token('textMuted') };

const sectionHeadingStyle: CSSProperties = {
  margin: `0 0 ${space.sm}px`,
  fontSize: fontSize.sm,
  fontWeight: 600,
  color: token('textMuted'),
};

const disclosureStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: space.xs,
  margin: `0 0 ${space.sm}px -${space.sm}px`,
  padding: `2px ${space.sm}px`,
  border: 'none',
  borderRadius: radius.sm,
  background: 'transparent',
  color: token('textMuted'),
  fontSize: fontSize.sm,
  fontWeight: 600,
  cursor: 'pointer',
};

const rowStateStyle: CSSProperties = {
  flexShrink: 0,
  fontSize: fontSize.sm,
  color: token('textMuted'),
  whiteSpace: 'nowrap',
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

// One bordered list with hairline dividers (not a card per row): long lists stay calm.
const listStyle: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  borderRadius: radius.md,
  border: `1px solid ${token('border')}`,
  background: token('surface'),
  overflow: 'hidden',
};

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: space.md,
  minHeight: 44,
  boxSizing: 'border-box',
  padding: `${space.sm}px ${space.md}px`,
  borderTop: `1px solid ${token('border')}`,
};

const rowTextStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  minWidth: 0,
  overflow: 'hidden',
};

const agentNameStyle: CSSProperties = {
  fontSize: fontSize.base,
  fontWeight: 600,
};

const statusStyle: CSSProperties = {
  fontSize: fontSize.sm,
  color: token('textMuted'),
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const actionBtnBase: CSSProperties = {
  padding: '5px 12px',
  borderRadius: radius.sm,
  fontSize: fontSize.base,
  whiteSpace: 'nowrap',
  flexShrink: 0,
};
