// MCP — one library of MCP servers, kept in sync with each agent's own MCP config.
//
// Same shape as the Skills screen: a sync MATRIX (a server per row; the library and each
// agent per column; a state chip per cell) and, for the selected server, a DETAIL panel
// with per-agent actions (pull ← / push → / diff / delete from agent) plus library actions
// (edit, push to all, delete from library). Rows are the union of the library and every
// readable agent file, so deleting a library entry never hides what an agent still has.
//
// Env/header VALUES are write-only here: the form sends a new value or nothing ("keep"),
// and main never sends one back — not in the snapshot, not in the diff. Pushing into an
// agent file opens main's native confirmation; a declined push comes back as `saved: false`.
// Overwrites, merges and deletes take a second in-screen confirmation first, as in Skills.

import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { disabledOpacity, elevation, fontSize, radius, space, token } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import { useT, type TranslateFn } from '../../i18n';
import { ScrollTabScreen } from '../../components/TabScreenShell';
import { LoadingButton } from '../../components/ui/LoadingButton';
import { EyeIcon } from '../../components/ui/EyeIcon';
import {
  buttonAccentChrome,
  buttonGhostChrome,
  controlInputStyle,
  segmentButtonChrome,
  segmentedRootStyle,
} from '../../components/ui/controlStyles';
import { AGENT_SPECS } from '../../../shared/aiProviders';
import { visibleMcpAgents } from './mcpColumns';
import { ipcErrorFromUnknown } from '../../../shared/ipc-errors';
import {
  MCP_TRANSPORTS,
  isMcpName,
  mcpSummary,
  type McpAgentId,
  type McpAgentInfo,
  type McpDiffResult,
  type McpFieldDiff,
  type McpMatrixRow,
  type McpSaveRequest,
  type McpServerView,
  type McpSnapshot,
  type McpSyncState,
  type McpTransport,
  type McpWriteResult,
} from '../../../shared/mcp';

const mono = 'ui-monospace, monospace';

function errorText(t: TranslateFn, err: unknown): string {
  const { code } = ipcErrorFromUnknown(err);
  const key = `mcp.errors.${code}`;
  const translated = t(key);
  return translated !== key ? translated : t('mcp.errors.generic');
}

const agentName = (id: McpAgentId): string => AGENT_SPECS[id].name;

interface Confirm {
  text: string;
  confirmLabel: string;
  run: () => void;
}

export function McpHome() {
  const t = useT();
  const [snap, setSnap] = useState<McpSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<McpServerView | 'new' | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [diff, setDiff] = useState<McpDiffResult | null>(null);

  const load = useCallback(() => {
    setFailed(false);
    window.aiopt.mcp
      .get()
      .then(setSnap)
      .catch(() => setFailed(true));
  }, []);
  useEffect(load, [load]);

  // Keep the selection valid across reloads; drop the diff/confirm when it changes.
  useEffect(() => {
    if (snap && selected && !snap.rows.some((r) => r.name === selected)) setSelected(null);
  }, [snap, selected]);
  useEffect(() => {
    setDiff(null);
    setConfirm(null);
  }, [selected]);

  /** Run one action under a shared busy/notice guard; `saved: false` = the user declined. */
  const act = useCallback(
    async (action: () => Promise<McpSnapshot | McpWriteResult>): Promise<boolean> => {
      setBusy(true);
      setNotice(null);
      try {
        const r = await action();
        if ('snapshot' in r) {
          setSnap(r.snapshot);
          if (!r.saved) setNotice({ text: t('mcp.declined'), error: false });
        } else setSnap(r);
        return true;
      } catch (err) {
        setNotice({ text: errorText(t, err), error: true });
        return false;
      } finally {
        setBusy(false);
        setConfirm(null);
      }
    },
    [t],
  );

  const onLoadDiff = async (agentId: McpAgentId, name: string) => {
    setBusy(true);
    setNotice(null);
    try {
      setDiff(await window.aiopt.mcp.diff(agentId, name));
    } catch (err) {
      setNotice({ text: errorText(t, err), error: true });
    } finally {
      setBusy(false);
    }
  };

  const columns = snap ? visibleMcpAgents(snap.agents, snap.rows) : [];
  const selectedRow = snap && selected ? snap.rows.find((r) => r.name === selected) ?? null : null;
  const unreadable = snap?.agents.filter((a) => a.unreadable) ?? [];

  return (
    <ScrollTabScreen>
      <h1 className="sr-only">{t('mcp.title')}</h1>
      <section style={toolbarStyle}>
        <p style={{ margin: 0, flex: 1, minWidth: 240, fontSize: fontSize.sm, color: token('textMuted') }}>{t('mcp.intro')}</p>
        <button type="button" onClick={() => setEditing('new')} disabled={!snap} style={buttonAccentChrome('md')}>
          {t('mcp.add')}
        </button>
        <button type="button" onClick={load} style={buttonGhostChrome('md')}>
          {t('mcp.refresh')}
        </button>
      </section>

      {notice && (
        <p role={notice.error ? 'alert' : 'status'} style={{ margin: `0 0 ${space.lg}px`, fontSize: fontSize.sm, color: token(notice.error ? 'danger' : 'textMuted') }}>
          {notice.text}
        </p>
      )}
      {snap && !snap.secretsAvailable && <p style={warnStyle}>{t('mcp.secretsUnavailable')}</p>}
      {unreadable.map((a) => (
        <p key={a.agentId} style={warnStyle}>
          {t('mcp.unreadable').replace('{{agent}}', agentName(a.agentId)).replace('{{path}}', a.configDisplayPath)}
        </p>
      ))}

      {failed ? (
        <p role="alert" style={{ fontSize: fontSize.md, color: token('danger') }}>{t('mcp.failed')}</p>
      ) : !snap ? (
        <p style={{ fontSize: fontSize.md, color: token('textMuted') }}>{t('mcp.loading')}</p>
      ) : (
        <>
          {snap.rows.length === 0 ? (
            <div style={emptyStyle}>
              <p style={{ margin: 0, fontSize: fontSize.md }}>{t('mcp.empty')}</p>
            </div>
          ) : (
            <div style={{ overflowX: 'auto', marginTop: space.sm }}>
              <Matrix rows={snap.rows} agents={columns} selected={selected} onSelect={setSelected} t={t} />
            </div>
          )}
          <p style={{ margin: `${space.md}px 0 0`, fontSize: fontSize.xs, color: token('textMuted') }}>
            {t('mcp.files')} {columns.map((a) => `${agentName(a.agentId)} ${a.configDisplayPath}`).join(' · ')}
          </p>
          <p style={{ margin: `${space.xs}px 0 0`, fontSize: fontSize.xs, color: token('textMuted') }}>{t('mcp.claudeNote')}</p>

          {selectedRow && (
            <DetailPanel
              row={selectedRow}
              agents={columns}
              busy={busy}
              confirm={confirm}
              setConfirm={setConfirm}
              diff={diff}
              t={t}
              onEdit={() => selectedRow.library && setEditing(selectedRow.library)}
              onLoadDiff={(agentId) => void onLoadDiff(agentId, selectedRow.name)}
              onCloseDiff={() => setDiff(null)}
              onPull={(agentId) => void act(() => window.aiopt.mcp.pull(agentId, selectedRow.name))}
              onPush={(agentIds) => void act(() => window.aiopt.mcp.push(selectedRow.name, agentIds))}
              onMerge={(agentId, picks) =>
                void act(() => window.aiopt.mcp.merge(agentId, selectedRow.name, picks)).then((ok) => ok && setDiff(null))
              }
              onDelete={() => void act(() => window.aiopt.mcp.delete(selectedRow.name))}
              onDeleteAgent={(agentId) => void act(() => window.aiopt.mcp.deleteAgent(agentId, selectedRow.name))}
            />
          )}
        </>
      )}

      {editing && snap && (
        <ServerForm
          initial={editing === 'new' ? null : editing}
          existingNames={snap.rows.filter((r) => r.library).map((r) => r.name)}
          secretsAvailable={snap.secretsAvailable}
          t={t}
          onClose={() => setEditing(null)}
          onSave={async (req) => {
            const ok = await act(() => window.aiopt.mcp.save(req));
            if (ok) {
              setEditing(null);
              setSelected(req.name);
            }
          }}
          saving={busy}
        />
      )}
    </ScrollTabScreen>
  );
}

function Matrix({
  rows,
  agents,
  selected,
  onSelect,
  t,
}: {
  rows: McpMatrixRow[];
  agents: McpAgentInfo[];
  selected: string | null;
  onSelect: (name: string) => void;
  t: TranslateFn;
}) {
  const gridTemplateColumns = `minmax(150px, 1.4fr) 84px ${agents.map(() => '96px').join(' ')}`;
  return (
    <div style={{ minWidth: 'fit-content', background: token('bg') }}>
      <div style={{ ...matrixRowStyle, gridTemplateColumns }}>
        <div style={headCellStyle}>{t('mcp.server')}</div>
        <div style={{ ...headCellStyle, textAlign: 'center' }}>{t('mcp.library')}</div>
        {agents.map((a) => (
          <div key={a.agentId} style={{ ...headCellStyle, textAlign: 'center' }} title={agentName(a.agentId)}>
            {agentName(a.agentId)}
          </div>
        ))}
      </div>
      {rows.map((row) => {
        const isSel = row.name === selected;
        return (
          <button
            key={row.name}
            type="button"
            aria-pressed={isSel}
            onClick={() => onSelect(row.name)}
            {...hoverBackground(isSel ? token('surfaceHover') : 'transparent', token('surfaceHover'))}
            style={{
              ...matrixRowStyle,
              gridTemplateColumns,
              width: '100%',
              textAlign: 'left',
              border: 'none',
              borderTop: `1px solid ${token('border')}`,
              background: isSel ? token('surfaceHover') : 'transparent',
              cursor: 'pointer',
              color: token('text'),
            }}
          >
            <div style={{ ...bodyCellStyle, fontWeight: isSel ? 600 : 400 }}>{row.name}</div>
            <div style={{ ...bodyCellStyle, justifyContent: 'center' }}>
              {row.library ? (
                <span style={{ fontSize: fontSize.xs, color: token('accent') }} title={t('mcp.state.inLibrary')}>●</span>
              ) : (
                <Absent />
              )}
            </div>
            {agents.map((a) => (
              <div key={a.agentId} style={{ ...bodyCellStyle, justifyContent: 'center' }}>
                <CellChip info={a} cell={row.agents[a.agentId]} t={t} />
              </div>
            ))}
          </button>
        );
      })}
    </div>
  );
}

function CellChip({ info, cell, t }: { info: McpAgentInfo; cell: McpMatrixRow['agents'][McpAgentId]; t: TranslateFn }) {
  if (info.unreadable) return <MutedNote text={t('mcp.state.unreadable')} />;
  if (!cell) return <Absent />;
  if (cell.state === 'library-only' && !cell.supported) return <MutedNote text={t('mcp.state.unsupported')} />;
  return <StateChip state={cell.state} t={t} />;
}

function DetailPanel({
  row,
  agents,
  busy,
  confirm,
  setConfirm,
  diff,
  t,
  onEdit,
  onLoadDiff,
  onCloseDiff,
  onPull,
  onPush,
  onMerge,
  onDelete,
  onDeleteAgent,
}: {
  row: McpMatrixRow;
  agents: McpAgentInfo[];
  busy: boolean;
  confirm: Confirm | null;
  setConfirm: (c: Confirm | null) => void;
  diff: McpDiffResult | null;
  t: TranslateFn;
  onEdit: () => void;
  onLoadDiff: (agentId: McpAgentId) => void;
  onCloseDiff: () => void;
  onPull: (agentId: McpAgentId) => void;
  onPush: (agentIds: McpAgentId[]) => void;
  onMerge: (agentId: McpAgentId, picks: string[]) => void;
  onDelete: () => void;
  onDeleteAgent: (agentId: McpAgentId) => void;
}) {
  const lib = row.library;
  const keys = lib ? [...lib.env, ...lib.headers] : [];
  // Agents push-to-all reaches: readable, and able to take this transport.
  const pushTargets = agents.filter((a) => !a.unreadable && row.agents[a.agentId]?.supported).map((a) => a.agentId);
  // Deleting the only copy anywhere escalates the confirmation.
  const copyCount = (lib ? 1 : 0) + agents.filter((a) => row.agents[a.agentId]?.entry).length;

  return (
    <section style={detailStyle}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: space.md, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: fontSize.xl }}>{row.name}</h2>
        {lib && <span style={badgeStyle}>{t(`mcp.transport.${lib.transport}`)}</span>}
      </div>
      {lib ? (
        <>
          <div style={summaryStyle} title={mcpSummary(lib)}>{mcpSummary(lib)}</div>
          {keys.length > 0 && (
            <div style={{ fontSize: fontSize.xs, color: token('textMuted'), marginTop: space.xs }}>
              {keys.map((k) => (k.set ? k.key : `${k.key} (${t('mcp.valueMissing')})`)).join(', ')}
            </div>
          )}
        </>
      ) : (
        <p style={{ margin: `${space.xs}px 0 0`, color: token('textMuted'), fontSize: fontSize.base }}>{t('mcp.detail.notInLibrary')}</p>
      )}

      {lib && (
        <div style={{ display: 'flex', gap: space.md, flexWrap: 'wrap', margin: `${space.lg}px 0` }}>
          <button type="button" disabled={busy} onClick={onEdit} {...hoverBackground('transparent', token('surfaceHover'))} style={smallGhostStyle}>
            {t('mcp.actions.edit')}
          </button>
          {pushTargets.length > 0 && (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                setConfirm({ text: t('mcp.confirm.pushAll'), confirmLabel: t('mcp.actions.push'), run: () => onPush(pushTargets) })
              }
              {...hoverBackground('transparent', token('surfaceHover'))}
              style={smallGhostStyle}
            >
              {t('mcp.actions.pushAll')}
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirm({ text: t('mcp.confirm.delete'), confirmLabel: t('mcp.actions.delete'), run: onDelete })}
            {...hoverBackground('transparent', token('surfaceHover'))}
            style={{ ...smallGhostStyle, color: token('danger'), borderColor: token('danger') }}
          >
            {t('mcp.actions.delete')}
          </button>
        </div>
      )}
      {!lib && <div style={{ height: space.lg }} />}

      {confirm && (
        <div style={confirmBarStyle}>
          <span style={{ fontSize: fontSize.md, marginRight: 'auto' }}>{confirm.text}</span>
          <button type="button" disabled={busy} onClick={confirm.run} {...hoverBackground(token('danger'), token('dangerHover'))} style={dangerStyle}>
            {confirm.confirmLabel}
          </button>
          <button type="button" onClick={() => setConfirm(null)} {...hoverBackground('transparent', token('surfaceHover'))} style={smallGhostStyle}>
            {t('mcp.confirm.cancel')}
          </button>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', border: `1px solid ${token('border')}`, borderRadius: radius.lg, overflow: 'hidden' }}>
        {agents.map((a, i) => {
          const cell = row.agents[a.agentId];
          const state = cell?.state;
          const canPush = cell?.supported === true;
          return (
            <div
              key={a.agentId}
              style={{ display: 'flex', alignItems: 'center', gap: space.md, padding: '10px 14px', borderTop: i === 0 ? 'none' : `1px solid ${token('border')}` }}
            >
              <span style={{ fontSize: fontSize.md, minWidth: 120 }}>{agentName(a.agentId)}</span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginRight: 'auto', minWidth: 0 }}>
                <span>
                  <CellChip info={a} cell={cell} t={t} />
                </span>
                {cell?.entry && (state === 'agent-only' || state === 'differs') && (
                  <span style={{ ...summaryStyle, marginTop: 0, fontSize: fontSize.xs }} title={mcpSummary(cell.entry)}>
                    {mcpSummary(cell.entry)}
                  </span>
                )}
                {cell && !canPush && lib && state !== 'library-only' && (
                  <span style={{ fontSize: fontSize.xs, color: token('textMuted') }}>{t('mcp.detail.cannotPush')}</span>
                )}
              </div>
              {/* agent-only → pull creates the library entry (no agent file changes). */}
              {state === 'agent-only' && <ActionButton label={t('mcp.actions.pull')} disabled={busy} onClick={() => onPull(a.agentId)} />}
              {/* library-only → push writes the agent file (main confirms natively). */}
              {state === 'library-only' && canPush && (
                <ActionButton label={t('mcp.actions.push')} disabled={busy} onClick={() => onPush([a.agentId])} />
              )}
              {state === 'differs' && (
                <>
                  <ActionButton label={t('mcp.actions.diff')} disabled={busy} onClick={() => onLoadDiff(a.agentId)} />
                  {canPush && (
                    <ActionButton
                      label={t('mcp.actions.push')}
                      disabled={busy}
                      onClick={() =>
                        setConfirm({ text: t('mcp.confirm.overwriteAgent'), confirmLabel: t('mcp.actions.push'), run: () => onPush([a.agentId]) })
                      }
                    />
                  )}
                  <ActionButton
                    label={t('mcp.actions.pull')}
                    disabled={busy}
                    onClick={() =>
                      setConfirm({ text: t('mcp.confirm.overwriteLibrary'), confirmLabel: t('mcp.actions.pull'), run: () => onPull(a.agentId) })
                    }
                  />
                </>
              )}
              {cell?.entry && (
                <ActionButton
                  label={t('mcp.actions.deleteAgent')}
                  danger
                  disabled={busy}
                  onClick={() =>
                    setConfirm({
                      text: copyCount <= 1 ? t('mcp.confirm.deleteAgentLast') : t('mcp.confirm.deleteAgent'),
                      confirmLabel: t('mcp.actions.delete'),
                      run: () => onDeleteAgent(a.agentId),
                    })
                  }
                />
              )}
            </div>
          );
        })}
      </div>

      {diff && diff.name === row.name && (
        <DiffPanel
          key={`${diff.agentId}/${diff.name}`}
          result={diff}
          busy={busy}
          t={t}
          onClose={onCloseDiff}
          onMerge={(picks) =>
            setConfirm({ text: t('mcp.confirm.merge'), confirmLabel: t('mcp.diff.merge'), run: () => onMerge(diff.agentId, picks) })
          }
        />
      )}
    </section>
  );
}

function fieldLabel(f: McpFieldDiff, t: TranslateFn): string {
  if (f.kind === 'spec') return t('mcp.diff.spec');
  return `${t(f.kind === 'env' ? 'mcp.diff.env' : 'mcp.diff.header')} ${f.key ?? ''}`;
}

function DiffPanel({
  result,
  busy,
  t,
  onClose,
  onMerge,
}: {
  result: McpDiffResult;
  busy: boolean;
  t: TranslateFn;
  onClose: () => void;
  onMerge: (picks: string[]) => void;
}) {
  const [agentPicks, setAgentPicks] = useState<Set<string>>(new Set());
  const picks = result.fields.filter((f) => agentPicks.has(f.field)).map((f) => f.field);
  return (
    <div style={{ marginTop: space.lg, border: `1px solid ${token('border')}`, borderRadius: radius.lg, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: space.md, padding: '10px 14px', background: token('surface') }}>
        <strong style={{ fontSize: fontSize.md }}>
          {t('mcp.diff.title')} · {agentName(result.agentId)}
        </strong>
        <button type="button" onClick={onClose} {...hoverBackground('transparent', token('surfaceHover'))} style={{ ...smallGhostStyle, marginLeft: 'auto' }}>
          {t('mcp.diff.close')}
        </button>
      </div>
      {result.fields.length === 0 ? (
        <p style={{ margin: 0, padding: '12px 14px', color: token('textMuted'), fontSize: fontSize.md }}>{t('mcp.diff.empty')}</p>
      ) : (
        <>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {result.fields.map((f) => (
              <li key={f.field} style={{ borderTop: `1px solid ${token('border')}`, padding: '8px 14px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: space.md, fontSize: fontSize.base }}>
                  <span style={{ ...diffTagStyle, color: diffColor(f.status) }}>{t(`mcp.diff.${f.status}`)}</span>
                  <span style={{ fontFamily: mono, fontSize: fontSize.sm, wordBreak: 'break-all', marginRight: 'auto' }}>{fieldLabel(f, t)}</span>
                  <PickToggle
                    value={agentPicks.has(f.field) ? 'agent' : 'library'}
                    disabled={busy}
                    t={t}
                    onChange={(side) =>
                      setAgentPicks((prev) => {
                        const next = new Set(prev);
                        if (side === 'agent') next.add(f.field);
                        else next.delete(f.field);
                        return next;
                      })
                    }
                  />
                </div>
                {f.kind === 'spec' && (
                  <div style={specGridStyle}>
                    <SpecSide title={t('mcp.diff.library')} text={f.library} t={t} />
                    <SpecSide title={t('mcp.diff.agent')} text={f.agent} t={t} />
                  </div>
                )}
              </li>
            ))}
          </ul>
          <div style={{ display: 'flex', alignItems: 'center', gap: space.md, padding: '10px 14px', borderTop: `1px solid ${token('border')}` }}>
            <span style={{ fontSize: fontSize.xs, color: token('textMuted'), marginRight: 'auto' }}>{t('mcp.diff.mergeHint')}</span>
            <button
              type="button"
              disabled={busy || picks.length === 0}
              onClick={() => onMerge(picks)}
              {...hoverBackground(token('accent'), token('accentHover'))}
              style={{
                ...buttonAccentChrome('sm'),
                opacity: busy || picks.length === 0 ? disabledOpacity : 1,
                cursor: busy || picks.length === 0 ? 'default' : 'pointer',
              }}
            >
              {t('mcp.diff.merge')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function SpecSide({ title, text, t }: { title: string; text: string | undefined; t: TranslateFn }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: fontSize.xs, fontWeight: 600, color: token('textMuted'), marginBottom: 4 }}>{title}</div>
      {text === undefined ? (
        <p style={{ margin: 0, fontSize: fontSize.xs, color: token('textMuted'), fontStyle: 'italic' }}>{t('mcp.diff.absent')}</p>
      ) : (
        <pre style={specPreStyle}>{text}</pre>
      )}
    </div>
  );
}

function PickToggle({
  value,
  disabled,
  onChange,
  t,
}: {
  value: 'library' | 'agent';
  disabled: boolean;
  onChange: (side: 'library' | 'agent') => void;
  t: TranslateFn;
}) {
  const options = [
    { side: 'library' as const, label: t('mcp.diff.useLibrary') },
    { side: 'agent' as const, label: t('mcp.diff.useAgent') },
  ];
  return (
    <div role="group" style={segmentedRootStyle}>
      {options.map(({ side, label }, index) => {
        const active = value === side;
        return (
          <button
            key={side}
            type="button"
            aria-pressed={active}
            disabled={disabled}
            onClick={() => onChange(side)}
            style={{
              ...segmentButtonChrome('sm'),
              borderLeft: index === 0 ? 'none' : `1px solid ${token('border')}`,
              background: active ? token('accent') : 'transparent',
              color: active ? token('accentText') : token('text'),
              cursor: disabled || active ? 'default' : 'pointer',
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

function ActionButton({ label, disabled, onClick, danger = false }: { label: string; disabled: boolean; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      {...hoverBackground('transparent', token('surfaceHover'))}
      style={danger ? { ...actionButtonStyle, color: token('danger') } : actionButtonStyle}
    >
      {label}
    </button>
  );
}

const STATE_COLOR: Record<McpSyncState, 'textMuted' | 'accent' | 'danger'> = {
  same: 'textMuted',
  'library-only': 'accent',
  'agent-only': 'accent',
  differs: 'danger',
};

const STATE_KEY: Record<McpSyncState, string> = {
  same: 'same',
  'library-only': 'libraryOnly',
  'agent-only': 'agentOnly',
  differs: 'differs',
};

function StateChip({ state, t }: { state: McpSyncState; t: TranslateFn }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: fontSize.xs, color: token(STATE_COLOR[state]), whiteSpace: 'nowrap' }}>
      <span aria-hidden>{state === 'same' ? '✓' : state === 'differs' ? '△' : '●'}</span>
      {t(`mcp.state.${STATE_KEY[state]}`)}
    </span>
  );
}

function MutedNote({ text }: { text: string }) {
  return <span style={{ fontSize: fontSize.xs, color: token('textMuted'), whiteSpace: 'nowrap' }}>{text}</span>;
}

function Absent() {
  return <span style={{ color: token('textMuted') }} aria-hidden>—</span>;
}

function diffColor(status: McpFieldDiff['status']): string {
  return token(status === 'deleted' ? 'danger' : status === 'added' ? 'accent' : 'text');
}

interface VarRow {
  key: string;
  /** Empty string with `stored` → keep the stored value. */
  value: string;
  stored: boolean;
  /** The value field shows plaintext. */
  shown: boolean;
}

function ServerForm({
  initial,
  existingNames,
  secretsAvailable,
  t,
  onClose,
  onSave,
  saving,
}: {
  initial: McpServerView | null;
  existingNames: string[];
  secretsAvailable: boolean;
  t: TranslateFn;
  onClose: () => void;
  onSave: (req: McpSaveRequest) => Promise<void>;
  saving: boolean;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [transport, setTransport] = useState<McpTransport>(initial?.transport ?? 'stdio');
  const [command, setCommand] = useState(initial?.command ?? '');
  const [args, setArgs] = useState((initial?.args ?? []).join('\n'));
  const [url, setUrl] = useState(initial?.url ?? '');
  const toRows = (list: McpServerView['env']): VarRow[] => list.map((v) => ({ key: v.key, value: '', stored: v.set, shown: false }));
  const [revealing, setRevealing] = useState<number | null>(null);
  const [revealError, setRevealError] = useState<string | null>(null);
  const [env, setEnv] = useState<VarRow[]>(toRows(initial?.env ?? []));
  const [headers, setHeaders] = useState<VarRow[]>(toRows(initial?.headers ?? []));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const nameTaken = name !== initial?.name && existingNames.includes(name);
  const vars = transport === 'stdio' ? env : headers;
  const setVars = transport === 'stdio' ? setEnv : setHeaders;
  const varsOk = vars.every((v) => v.key.trim() !== '') && new Set(vars.map((v) => v.key.trim().toLowerCase())).size === vars.length;
  const needsSecret = vars.some((v) => v.value !== '');
  const varKind: 'env' | 'header' = transport === 'stdio' ? 'env' : 'header';

  // The eye either fetches the stored value (nothing typed yet) or just toggles mask /
  // plaintext. Fetching is the gated mcp:reveal-value read (one value per click); the value
  // then lives only in this form's state and is dropped with it. Mirrors the provider key.
  const toggleValue = async (i: number): Promise<void> => {
    const row = vars[i];
    if (!row) return;
    const update = (patch: Partial<VarRow>) => setVars((prev) => prev.map((x, j) => (j === i ? { ...x, ...patch } : x)));
    if (row.value === '' && row.stored && initial && !row.shown) {
      setRevealing(i);
      setRevealError(null);
      try {
        const { value } = await window.aiopt.mcp.revealValue(initial.name, varKind, row.key);
        if (value !== null) update({ value, shown: true });
      } catch (err) {
        setRevealError(errorText(t, err));
      } finally {
        setRevealing(null);
      }
      return;
    }
    update({ shown: !row.shown });
  };
  const valid =
    isMcpName(name) &&
    !nameTaken &&
    (transport === 'stdio' ? command.trim() !== '' : /^https?:\/\/\S+$/i.test(url.trim())) &&
    varsOk &&
    (!needsSecret || secretsAvailable);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid || saving) return;
    const out = vars.map((v) => (v.value === '' && v.stored ? { key: v.key.trim() } : { key: v.key.trim(), value: v.value }));
    void onSave({
      name,
      ...(initial ? { originalName: initial.name } : {}),
      transport,
      ...(transport === 'stdio'
        ? { command: command.trim(), args: args.split('\n').map((a) => a.trim()).filter((a) => a !== '') }
        : { url: url.trim() }),
      env: transport === 'stdio' ? out : [],
      headers: transport === 'stdio' ? [] : out,
    });
  };

  return (
    <div style={overlayStyle} role="dialog" aria-modal="true" aria-labelledby="mcp-form-title">
      <form style={panelStyle} onSubmit={submit}>
        <h2 id="mcp-form-title" style={{ margin: `0 0 ${space.lg}px`, fontSize: fontSize['2xl'] }}>
          {initial ? t('mcp.form.editTitle') : t('mcp.form.addTitle')}
        </h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: space.lg }}>
          <label style={fieldStyle}>
            {t('mcp.form.name')}
            <input value={name} onChange={(e) => setName(e.target.value.trim())} style={controlInputStyle} spellCheck={false} />
            {name !== '' && !isMcpName(name) && <span style={hintErrorStyle}>{t('mcp.form.nameInvalid')}</span>}
            {nameTaken && <span style={hintErrorStyle}>{t('mcp.form.nameTaken')}</span>}
          </label>
          <div style={fieldStyle}>
            <span id="mcp-form-transport">{t('mcp.form.transport')}</span>
            <div role="group" aria-labelledby="mcp-form-transport" style={segmentedRootStyle}>
              {MCP_TRANSPORTS.map((opt, index) => {
                const active = transport === opt;
                return (
                  <button
                    key={opt}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setTransport(opt)}
                    style={{
                      ...segmentButtonChrome('md'),
                      borderLeft: index === 0 ? 'none' : `1px solid ${token('border')}`,
                      background: active ? token('accent') : 'transparent',
                      color: active ? token('accentText') : token('text'),
                    }}
                  >
                    {t(`mcp.transport.${opt}`)}
                  </button>
                );
              })}
            </div>
          </div>
          {transport === 'stdio' ? (
            <>
              <label style={fieldStyle}>
                {t('mcp.form.command')}
                <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" style={{ ...controlInputStyle, fontFamily: mono }} spellCheck={false} />
              </label>
              <label style={fieldStyle}>
                {t('mcp.form.args')}
                <textarea
                  value={args}
                  onChange={(e) => setArgs(e.target.value)}
                  rows={3}
                  spellCheck={false}
                  style={{ ...textareaStyle, fontFamily: mono }}
                />
              </label>
            </>
          ) : (
            <label style={fieldStyle}>
              {t('mcp.form.url')}
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" style={{ ...controlInputStyle, fontFamily: mono }} spellCheck={false} />
            </label>
          )}
          <div style={fieldStyle}>
            <span>{transport === 'stdio' ? t('mcp.form.env') : t('mcp.form.headers')}</span>
            {vars.map((v, i) => (
              <div key={i} style={{ display: 'flex', gap: space.sm }}>
                <input
                  value={v.key}
                  aria-label={t('mcp.form.key')}
                  placeholder={t('mcp.form.key')}
                  onChange={(e) => setVars(vars.map((x, j) => (j === i ? { ...x, key: e.target.value, stored: false } : x)))}
                  style={{ ...controlInputStyle, flex: 1, fontFamily: mono }}
                  spellCheck={false}
                />
                <input
                  type={v.shown ? 'text' : 'password'}
                  value={v.value}
                  aria-label={t('mcp.form.value')}
                  placeholder={v.stored ? t('mcp.form.valueKeep') : t('mcp.form.value')}
                  onChange={(e) => setVars(vars.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                  style={{ ...controlInputStyle, flex: 1, minWidth: 0, ...(v.shown ? { fontFamily: mono } : {}) }}
                  autoComplete="off"
                  spellCheck={false}
                />
                {(() => {
                  const canToggle = v.value !== '' || (v.stored && initial !== null);
                  const label = v.shown ? t('mcp.form.hideValue') : t('mcp.form.showValue');
                  return (
                    <button
                      type="button"
                      onClick={() => void toggleValue(i)}
                      disabled={!canToggle || revealing === i}
                      aria-pressed={v.shown}
                      aria-label={label}
                      title={label}
                      {...hoverBackground('transparent', token('surfaceHover'))}
                      style={{
                        ...eyeButtonStyle,
                        cursor: canToggle ? 'pointer' : 'default',
                        opacity: canToggle ? 1 : disabledOpacity,
                      }}
                    >
                      <EyeIcon off={v.shown} />
                    </button>
                  );
                })()}
                <button
                  type="button"
                  aria-label={t('mcp.form.removeVar')}
                  title={t('mcp.form.removeVar')}
                  onClick={() => setVars(vars.filter((_, j) => j !== i))}
                  style={buttonGhostChrome('md')}
                >
                  ×
                </button>
              </div>
            ))}
            <div>
              <button type="button" onClick={() => setVars([...vars, { key: '', value: '', stored: false, shown: false }])} style={buttonGhostChrome('sm')}>
                {t('mcp.form.addVar')}
              </button>
            </div>
            {revealError && (
              <span role="alert" style={hintErrorStyle}>
                {revealError}
              </span>
            )}
            {needsSecret && !secretsAvailable && <span style={hintErrorStyle}>{t('mcp.secretsUnavailable')}</span>}
            <span style={{ fontSize: fontSize.xs }}>{t('mcp.form.valuesNote')}</span>
          </div>
          <span style={{ fontSize: fontSize.xs, color: token('textMuted') }}>{t('mcp.form.libraryNote')}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: space.md, marginTop: space['2xl'] }}>
          <button type="button" onClick={onClose} style={buttonGhostChrome('md')}>
            {t('mcp.cancel')}
          </button>
          <LoadingButton type="submit" variant="accent" loading={saving} disabled={!valid}>
            {t('mcp.form.save')}
          </LoadingButton>
        </div>
      </form>
    </div>
  );
}



const eyeButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  width: 38,
  padding: 0,
  borderRadius: radius.sm,
  border: `1px solid ${token('borderStrong')}`,
  background: 'transparent',
  color: token('textMuted'),
};

const summaryStyle: CSSProperties = {
  fontFamily: mono,
  fontSize: fontSize.sm,
  color: token('textMuted'),
  marginTop: space.xs,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const badgeStyle: CSSProperties = {
  marginLeft: space.sm,
  padding: '1px 6px',
  border: `1px solid ${token('border')}`,
  borderRadius: radius.pill,
  fontSize: fontSize.xs,
  fontWeight: 400,
  color: token('textMuted'),
};

const warnStyle: CSSProperties = { margin: `0 0 ${space.md}px`, fontSize: fontSize.sm, color: token('danger') };

const overlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: token('overlay'),
  display: 'grid',
  placeItems: 'center',
  padding: space['2xl'],
  zIndex: 10,
};

const panelStyle: CSSProperties = {
  width: 'min(560px, 100%)',
  minWidth: 0,
  maxHeight: '100%',
  overflowY: 'auto',
  boxSizing: 'border-box',
  background: token('bg'),
  color: token('text'),
  border: `1px solid ${token('border')}`,
  borderRadius: radius.xl,
  boxShadow: elevation('modal'),
  padding: 20,
};

const fieldStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: space.xs,
  fontSize: fontSize.base,
  color: token('textMuted'),
};

const textareaStyle: CSSProperties = {
  padding: '8px 10px',
  borderRadius: radius.sm,
  border: `1px solid ${token('borderStrong')}`,
  background: token('surface'),
  color: token('text'),
  fontSize: fontSize.md,
  resize: 'vertical',
};

const hintErrorStyle: CSSProperties = { fontSize: fontSize.xs, color: token('danger') };

const toolbarStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: space.md,
  flexWrap: 'wrap',
  margin: `0 0 ${space.xl}px`,
};

const emptyStyle: CSSProperties = {
  marginTop: space['2xl'],
  padding: '32px 24px',
  border: `1px dashed ${token('border')}`,
  borderRadius: radius.lg,
  textAlign: 'center',
};

const matrixRowStyle: CSSProperties = { display: 'grid', alignItems: 'center', gap: space.md, padding: '8px 12px' };

const headCellStyle: CSSProperties = {
  fontSize: fontSize.sm,
  fontWeight: 600,
  color: token('textMuted'),
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const bodyCellStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  fontSize: fontSize.md,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const detailStyle: CSSProperties = {
  marginTop: space['2xl'],
  padding: space['2xl'],
  border: `1px solid ${token('border')}`,
  borderRadius: radius.lg,
  background: token('surface'),
};

const smallGhostStyle: CSSProperties = { ...buttonGhostChrome('sm'), borderRadius: radius.sm };

const actionButtonStyle: CSSProperties = {
  padding: '4px 10px',
  borderRadius: radius.sm,
  border: `1px solid ${token('border')}`,
  background: 'transparent',
  color: token('text'),
  cursor: 'pointer',
  fontSize: fontSize.sm,
  whiteSpace: 'nowrap',
};

const dangerStyle: CSSProperties = {
  padding: '6px 14px',
  borderRadius: radius.md,
  border: `1px solid ${token('danger')}`,
  background: token('danger'),
  color: token('accentText'),
  cursor: 'pointer',
  fontSize: fontSize.sm,
};

const confirmBarStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: space.md,
  padding: '10px 14px',
  marginBottom: space.lg,
  borderRadius: radius.md,
  border: `1px solid ${token('danger')}`,
};

const diffTagStyle: CSSProperties = { fontSize: fontSize.xs, fontWeight: 600, textTransform: 'uppercase', minWidth: 64 };

const specGridStyle: CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: space.md, padding: '8px 0 4px 76px' };

const specPreStyle: CSSProperties = {
  margin: 0,
  padding: space.sm,
  borderRadius: radius.sm,
  border: `1px solid ${token('border')}`,
  background: token('surfaceHover'),
  fontFamily: mono,
  fontSize: fontSize.xs,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};
