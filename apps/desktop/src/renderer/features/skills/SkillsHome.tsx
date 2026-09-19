// Skills sync view — a top-level screen (like UsageHome) where AiOpt is the CENTRAL
// library for skills scattered across each agent's global skills dir.
//
// Two panes: an at-a-glance sync MATRIX (a skill per row, the library + each agent
// per column, a status chip per cell) and, for the selected skill, a DETAIL panel
// with the per-agent actions (pull ← / push → / diff) plus library-level actions
// (push to all, delete). Every skill is named by symbolic coordinates only — the
// renderer never sees or sends an absolute path; main resolves and allowlists them.
//
// Destructive actions (overwrite an agent's copy, overwrite the library, delete)
// go through a second confirmation, mirroring the Usage clear button.

import { useEffect, useMemo, useState } from 'react';
import { fontSize, radius, space, token } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import { useI18n, type Locale, type TranslateFn } from '../../i18n';
import { useSkills } from '../../hooks/useSkills';
import {
  deleteAgentSkill,
  deleteSkill,
  diffSkill,
  importSkill,
  mergeSkill,
  pullSkill,
  pushSkill,
  refreshSkills,
  revealSkill,
  setLibraryLocation,
  skillFileContent,
} from '../../lib/skillsStore';
import { skillsErrorMessage } from './errors';
import { AGENT_NAMES } from '../../../shared/aiProviders';
import type { AgentId } from '../../../shared/aiProviders';
import { newerSkillSide } from '../../../shared/skills';
import type {
  SkillDiffResult,
  SkillEntry,
  SkillFileContent,
  SkillFileDiff,
  SkillMatrixRow,
  SkillScope,
  SkillSyncState,
  SkillsLibraryLocation,
} from '../../../shared/skills';

const numberFormat = new Intl.NumberFormat();

function formatBytes(n: number): string {
  if (n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * A skill's newest-file mtime as a localized relative phrase ("2 hours ago", "刚刚"). Uses
 * `Intl.RelativeTimeFormat` so the wording is localized by the platform — no i18n JSON entry,
 * so no interpolation. Returns null when the time is unknown (mtime 0), so callers can omit it.
 */
function formatRelative(ms: number, locale: Locale): string | null {
  if (!ms) return null;
  const diff = ms - Date.now(); // negative = in the past
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (abs < minute) return rtf.format(Math.round(diff / 1000), 'second');
  if (abs < hour) return rtf.format(Math.round(diff / minute), 'minute');
  if (abs < day) return rtf.format(Math.round(diff / hour), 'hour');
  return rtf.format(Math.round(diff / day), 'day');
}

/** A pending destructive action awaiting a second confirmation. */
interface Confirm {
  text: string;
  confirmLabel: string;
  run: () => Promise<void>;
}

export function SkillsHome() {
  const { t, locale } = useI18n();
  const snapshot = useSkills();
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [diff, setDiff] = useState<{ agentId: AgentId; result: SkillDiffResult } | null>(null);

  // Available agents (those with a known skills dir) drive the matrix columns.
  const availableAgents = useMemo(
    () => snapshot.agents.filter((a) => a.available),
    [snapshot.agents],
  );

  // Keep the selection valid across rescans; drop the diff when the skill changes.
  useEffect(() => {
    if (selected && !snapshot.rows.some((r) => r.name === selected)) {
      setSelected(null);
    }
  }, [snapshot.rows, selected]);
  useEffect(() => {
    setDiff(null);
    setConfirm(null);
  }, [selected]);

  const selectedRow = selected ? snapshot.rows.find((r) => r.name === selected) ?? null : null;
  const agentName = (id: AgentId): string => AGENT_NAMES[id] ?? id;

  /** Run a mutating action with a shared busy/error guard, clearing any confirm. */
  async function act(fn: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(skillsErrorMessage(t, err));
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }

  async function onImport(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const name = await importSkill();
      if (name) setSelected(name);
    } catch (err) {
      setError(skillsErrorMessage(t, err));
    } finally {
      setBusy(false);
    }
  }

  async function onLoadDiff(agentId: AgentId, name: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setDiff({ agentId, result: await diffSkill(agentId, name) });
    } catch (err) {
      setError(skillsErrorMessage(t, err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ height: '100%', overflowY: 'auto' }}>
      <div style={{ maxWidth: 980, margin: '0 auto', padding: '24px 24px 48px' }}>
        <h1 style={{ margin: '0 0 4px', fontSize: fontSize['3xl'] }}>{t('skills.title')}</h1>
        <p style={{ margin: 0, color: token('textMuted'), fontSize: fontSize.md }}>
          {t('skills.subtitle')}
        </p>

        {/* Toolbar: central library path + location toggle + import + rescan. */}
        <section style={toolbarStyle}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginRight: 'auto', minWidth: 0 }}>
            <span style={{ fontSize: fontSize.sm, color: token('textMuted') }}>
              {t('skills.library.label')}
            </span>
            <button
              type="button"
              onClick={() => void revealSkill({ scope: 'central' })}
              title={t('skills.actions.reveal')}
              {...hoverBackground('transparent', token('surfaceHover'))}
              style={pathButtonStyle}
            >
              {snapshot.centralPath || '—'}
            </button>
          </div>
          <LocationToggle
            value={snapshot.libraryLocation}
            disabled={busy}
            onChange={(loc) => void act(() => setLibraryLocation(loc))}
            t={t}
          />
          <button
            type="button"
            onClick={() => void onImport()}
            disabled={busy}
            {...hoverBackground(token('accent'), token('accentHover'))}
            style={accentStyle}
          >
            {t('skills.actions.import')}
          </button>
          <button
            type="button"
            onClick={() => void act(() => refreshSkills())}
            disabled={busy}
            {...hoverBackground('transparent', token('surfaceHover'))}
            style={ghostStyle}
          >
            {t('skills.actions.rescan')}
          </button>
        </section>

        {error && (
          <p role="alert" style={{ margin: '0 0 16px', color: token('danger'), fontSize: fontSize.sm }}>
            {error}
          </p>
        )}

        {snapshot.rows.length === 0 ? (
          <div style={emptyStyle}>
            <p style={{ margin: '0 0 6px', fontSize: fontSize.md }}>{t('skills.empty')}</p>
            <p style={{ margin: 0, color: token('textMuted'), fontSize: fontSize.sm }}>
              {t('skills.emptyHint')}
            </p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto', marginTop: 8 }}>
            <Matrix
              rows={snapshot.rows}
              agents={availableAgents}
              selected={selected}
              onSelect={setSelected}
              t={t}
            />
          </div>
        )}

        {selectedRow && (
          <DetailPanel
            row={selectedRow}
            agents={availableAgents}
            agentName={agentName}
            busy={busy}
            confirm={confirm}
            setConfirm={setConfirm}
            diff={diff}
            onLoadDiff={(agentId) => void onLoadDiff(agentId, selectedRow.name)}
            onCloseDiff={() => setDiff(null)}
            onPull={(agentId) => void act(() => pullSkill(agentId, selectedRow.name))}
            onPush={(agentId) => void act(() => pushSkill(selectedRow.name, [agentId]))}
            onPushAll={() =>
              void act(() =>
                pushSkill(
                  selectedRow.name,
                  availableAgents.map((a) => a.id),
                ),
              )
            }
            onMerge={(agentId, agentPicks) =>
              void act(() => mergeSkill(agentId, selectedRow.name, agentPicks).then(() => setDiff(null)))
            }
            onDelete={() => void act(() => deleteSkill(selectedRow.name))}
            onDeleteAgent={(agentId) => void act(() => deleteAgentSkill(agentId, selectedRow.name))}
            onReveal={(ref) => void revealSkill(ref)}
            t={t}
            locale={locale}
          />
        )}
      </div>
    </div>
  );
}

function LocationToggle({
  value,
  disabled,
  onChange,
  t,
}: {
  value: SkillsLibraryLocation;
  disabled: boolean;
  onChange: (loc: SkillsLibraryLocation) => void;
  t: TranslateFn;
}) {
  const options: SkillsLibraryLocation[] = ['app', 'home'];
  return (
    <div role="group" aria-label={t('skills.library.label')} style={segmentedStyle}>
      {options.map((opt) => {
        const active = value === opt;
        return (
          <button
            key={opt}
            type="button"
            aria-pressed={active}
            disabled={disabled || active}
            onClick={() => onChange(opt)}
            style={{
              ...segmentButtonStyle,
              background: active ? token('accent') : 'transparent',
              color: active ? token('accentText') : token('text'),
              cursor: active ? 'default' : 'pointer',
            }}
          >
            {t(`skills.library.${opt}`)}
          </button>
        );
      })}
    </div>
  );
}

function Matrix({
  rows,
  agents,
  selected,
  onSelect,
  t,
}: {
  rows: SkillMatrixRow[];
  agents: { id: AgentId; name: string }[];
  selected: string | null;
  onSelect: (name: string) => void;
  t: TranslateFn;
}) {
  // grid: skill name | library | one column per available agent.
  const gridTemplateColumns = `minmax(150px, 1.4fr) 84px ${agents.map(() => '84px').join(' ')}`;
  return (
    <div style={{ minWidth: 'fit-content' }}>
      <div style={{ ...matrixRowStyle, gridTemplateColumns }}>
        <div style={headCellStyle}>{t('skills.skill')}</div>
        <div style={{ ...headCellStyle, textAlign: 'center' }}>{t('skills.central')}</div>
        {agents.map((a) => (
          <div key={a.id} style={{ ...headCellStyle, textAlign: 'center' }} title={a.name}>
            {a.name}
          </div>
        ))}
      </div>
      {rows.map((row) => {
        const isSel = row.name === selected;
        return (
          <button
            key={row.name}
            type="button"
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
              <StateDot state={row.central ? 'present' : 'absent'} t={t} />
            </div>
            {agents.map((a) => {
              const cell = row.agents[a.id];
              return (
                <div key={a.id} style={{ ...bodyCellStyle, justifyContent: 'center' }}>
                  {cell ? (
                    <StateChip
                      state={cell.state}
                      newer={newerSkillSide(row.central, cell.entry)}
                      t={t}
                    />
                  ) : (
                    <Absent />
                  )}
                </div>
              );
            })}
          </button>
        );
      })}
    </div>
  );
}

function DetailPanel({
  row,
  agents,
  agentName,
  busy,
  confirm,
  setConfirm,
  diff,
  onLoadDiff,
  onCloseDiff,
  onPull,
  onPush,
  onPushAll,
  onMerge,
  onDelete,
  onDeleteAgent,
  onReveal,
  t,
  locale,
}: {
  row: SkillMatrixRow;
  agents: { id: AgentId; name: string }[];
  agentName: (id: AgentId) => string;
  busy: boolean;
  confirm: Confirm | null;
  setConfirm: (c: Confirm | null) => void;
  diff: { agentId: AgentId; result: SkillDiffResult } | null;
  onLoadDiff: (agentId: AgentId) => void;
  onCloseDiff: () => void;
  onPull: (agentId: AgentId) => void;
  onPush: (agentId: AgentId) => void;
  onPushAll: () => void;
  onMerge: (agentId: AgentId, agentPicks: string[]) => void;
  onDelete: () => void;
  onDeleteAgent: (agentId: AgentId) => void;
  onReveal: (ref: { scope: 'central' | 'agent'; agentId?: AgentId; name?: string }) => void;
  t: TranslateFn;
  locale: Locale;
}) {
  const hasCentral = row.central !== null;
  const description = row.central?.meta?.description;

  // How many copies of this skill exist anywhere (library + each agent that has it).
  // When deleting an agent copy would drop the count to zero, it's the LAST copy —
  // the confirmation escalates to an unrecoverable-loss warning.
  const copyCount =
    (hasCentral ? 1 : 0) + agents.filter((a) => row.agents[a.id]?.entry != null).length;

  return (
    <section style={detailStyle}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: space.md, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: fontSize.xl }}>{row.name}</h2>
        {hasCentral && row.central && (
          <span style={{ fontSize: fontSize.sm, color: token('textMuted') }}>
            {numberFormat.format(row.central.fileCount)} {t('skills.meta.files')} ·{' '}
            {formatBytes(row.central.totalBytes)}
          </span>
        )}
      </div>
      <p style={{ margin: '4px 0 16px', color: token('textMuted'), fontSize: fontSize.base }}>
        {description || t('skills.detail.noDescription')}
      </p>

      {/* Library-level actions. */}
      <div style={{ display: 'flex', gap: space.md, flexWrap: 'wrap', marginBottom: 16 }}>
        {hasCentral && (
          <button
            type="button"
            onClick={() => onReveal({ scope: 'central', name: row.name })}
            {...hoverBackground('transparent', token('surfaceHover'))}
            style={smallGhostStyle}
          >
            {t('skills.actions.reveal')}
          </button>
        )}
        {hasCentral && agents.length > 0 && (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              setConfirm({
                text: t('skills.confirm.pushAll'),
                confirmLabel: t('skills.actions.push'),
                run: async () => onPushAll(),
              })
            }
            {...hoverBackground('transparent', token('surfaceHover'))}
            style={smallGhostStyle}
          >
            {t('skills.actions.pushAll')}
          </button>
        )}
        {hasCentral && (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              setConfirm({
                text: t('skills.confirm.delete'),
                confirmLabel: t('skills.actions.delete'),
                run: async () => onDelete(),
              })
            }
            {...hoverBackground('transparent', token('surfaceHover'))}
            style={{ ...smallGhostStyle, color: token('danger'), borderColor: token('danger') }}
          >
            {t('skills.actions.delete')}
          </button>
        )}
      </div>

      {confirm && (
        <div style={confirmBarStyle}>
          <span style={{ fontSize: fontSize.md, marginRight: 'auto' }}>{confirm.text}</span>
          <button
            type="button"
            disabled={busy}
            onClick={() => void confirm.run()}
            {...hoverBackground(token('danger'), token('dangerHover'))}
            style={dangerStyle}
          >
            {confirm.confirmLabel}
          </button>
          <button
            type="button"
            onClick={() => setConfirm(null)}
            {...hoverBackground('transparent', token('surfaceHover'))}
            style={smallGhostStyle}
          >
            {t('skills.confirm.cancel')}
          </button>
        </div>
      )}

      {/* Per-agent rows. */}
      <div style={{ display: 'flex', flexDirection: 'column', border: `1px solid ${token('border')}`, borderRadius: radius.lg, overflow: 'hidden' }}>
        {agents.map((a, i) => {
          const cell = row.agents[a.id];
          const state = cell?.state;
          const newer = newerSkillSide(row.central, cell?.entry ?? null);
          return (
            <div
              key={a.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: space.md,
                padding: '10px 14px',
                borderTop: i === 0 ? 'none' : `1px solid ${token('border')}`,
              }}
            >
              <span style={{ fontSize: fontSize.md, minWidth: 120 }}>{agentName(a.id)}</span>
              <div
                style={{ display: 'flex', flexDirection: 'column', gap: 2, marginRight: 'auto', minWidth: 0 }}
              >
                <span>{state ? <StateChip state={state} newer={newer} t={t} /> : <Absent />}</span>
                {state === 'differs' && (
                  <SideTimes
                    central={row.central}
                    agent={cell?.entry ?? null}
                    newer={newer}
                    locale={locale}
                    t={t}
                  />
                )}
              </div>
              {/* agent-only → pull creates the library copy (safe). */}
              {state === 'agent-only' && (
                <ActionButton label={t('skills.actions.pull')} disabled={busy} onClick={() => onPull(a.id)} />
              )}
              {/* central-only → push creates the agent copy (safe). */}
              {state === 'central-only' && (
                <ActionButton label={t('skills.actions.push')} disabled={busy} onClick={() => onPush(a.id)} />
              )}
              {/* differs → diff + overwriting sync in either direction (confirmed). */}
              {state === 'differs' && (
                <>
                  <ActionButton label={t('skills.actions.diff')} disabled={busy} onClick={() => onLoadDiff(a.id)} />
                  <ActionButton
                    label={t('skills.actions.push')}
                    disabled={busy}
                    onClick={() =>
                      setConfirm({
                        text: t('skills.confirm.overwriteAgent'),
                        confirmLabel: t('skills.actions.push'),
                        run: async () => onPush(a.id),
                      })
                    }
                  />
                  <ActionButton
                    label={t('skills.actions.pull')}
                    disabled={busy}
                    onClick={() =>
                      setConfirm({
                        text: t('skills.confirm.overwriteLibrary'),
                        confirmLabel: t('skills.actions.pull'),
                        run: async () => onPull(a.id),
                      })
                    }
                  />
                </>
              )}
              {state === 'same' && (
                <ActionButton label={t('skills.actions.diff')} disabled={busy} onClick={() => onLoadDiff(a.id)} />
              )}
              {/* Delete the agent's own copy — available whenever the agent HAS a copy.
                  Second confirmation; when this is the last copy anywhere, the confirm
                  text escalates to the unrecoverable-loss warning. */}
              {cell?.entry != null && (
                <ActionButton
                  label={t('skills.actions.deleteAgent')}
                  danger
                  disabled={busy}
                  onClick={() =>
                    setConfirm({
                      text:
                        copyCount <= 1
                          ? t('skills.confirm.deleteAgentLast')
                          : t('skills.confirm.deleteAgent'),
                      confirmLabel: t('skills.actions.delete'),
                      run: async () => onDeleteAgent(a.id),
                    })
                  }
                />
              )}
            </div>
          );
        })}
      </div>

      {diff && (
        <DiffPanel
          key={`${diff.agentId}/${diff.result.name}`}
          agentName={agentName(diff.agentId)}
          result={diff.result}
          busy={busy}
          onMerge={(agentPicks) =>
            setConfirm({
              text: t('skills.confirm.merge'),
              confirmLabel: t('skills.diff.merge'),
              run: async () => onMerge(diff.agentId, agentPicks),
            })
          }
          onClose={onCloseDiff}
          t={t}
        />
      )}
    </section>
  );
}

/** The sides that actually hold this file, given its diff status (central is the source). */
function sidesFor(status: SkillFileDiff['status']): SkillScope[] {
  if (status === 'added') return ['central']; // only central has it
  if (status === 'deleted') return ['agent']; // only agent has it
  return ['central', 'agent']; // modified → both
}

/** Cache key for one side of one file. */
function contentKey(side: SkillScope, relPath: string): string {
  return `${side} ${relPath}`;
}

type ContentState = SkillFileContent | 'loading' | 'error';

/**
 * The per-file diff, expandable for a text preview of each side, with a per-file
 * "use library / use agent" pick. Merge applies every `agent` pick back onto the
 * CENTRAL copy (added→remove, deleted→copy in, modified→overwrite); anything left
 * on the default `central` is untouched. The write-back is confirmed by the parent.
 */
function DiffPanel({
  agentName,
  result,
  busy,
  onMerge,
  onClose,
  t,
}: {
  agentName: string;
  result: SkillDiffResult;
  busy: boolean;
  onMerge: (agentPicks: string[]) => void;
  onClose: () => void;
  t: TranslateFn;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [picks, setPicks] = useState<Record<string, SkillScope>>({});
  const [contents, setContents] = useState<Record<string, ContentState>>({});

  function loadSide(side: SkillScope, relPath: string): void {
    const key = contentKey(side, relPath);
    setContents((prev) => {
      if (prev[key]) return prev; // already loading / loaded / errored
      void skillFileContent(result.agentId, result.name, side, relPath)
        .then((c) => setContents((p) => ({ ...p, [key]: c })))
        .catch(() => setContents((p) => ({ ...p, [key]: 'error' })));
      return { ...prev, [key]: 'loading' };
    });
  }

  function toggle(f: SkillFileDiff): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(f.relPath)) {
        next.delete(f.relPath);
      } else {
        next.add(f.relPath);
        if (!f.binary) for (const side of sidesFor(f.status)) loadSide(side, f.relPath);
      }
      return next;
    });
  }

  const pickOf = (relPath: string): SkillScope => picks[relPath] ?? 'central';
  const agentPicks = result.files.filter((f) => pickOf(f.relPath) === 'agent').map((f) => f.relPath);

  return (
    <div style={{ marginTop: 16, border: `1px solid ${token('border')}`, borderRadius: radius.lg, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: space.md, padding: '10px 14px', background: token('surface') }}>
        <strong style={{ fontSize: fontSize.md }}>
          {t('skills.diff.title')} · {agentName}
        </strong>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('skills.diff.close')}
          {...hoverBackground('transparent', token('surfaceHover'))}
          style={{ ...smallGhostStyle, marginLeft: 'auto' }}
        >
          {t('skills.diff.close')}
        </button>
      </div>
      {result.files.length === 0 ? (
        <p style={{ margin: 0, padding: '12px 14px', color: token('textMuted'), fontSize: fontSize.md }}>
          {t('skills.diff.empty')}
        </p>
      ) : (
        <>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {result.files.map((f) => {
              const isOpen = expanded.has(f.relPath);
              const pick = pickOf(f.relPath);
              return (
                <li key={f.relPath} style={{ borderTop: `1px solid ${token('border')}` }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: space.md, padding: '8px 14px', fontSize: fontSize.base }}>
                    <button
                      type="button"
                      onClick={() => toggle(f)}
                      aria-expanded={isOpen}
                      aria-label={isOpen ? t('skills.diff.collapse') : t('skills.diff.expand')}
                      {...hoverBackground('transparent', token('surfaceHover'))}
                      style={disclosureStyle}
                    >
                      <span aria-hidden>{isOpen ? '▾' : '▸'}</span>
                    </button>
                    <span style={{ ...diffTagStyle, color: diffColor(f.status) }}>
                      {t(`skills.diff.${f.status}`)}
                    </span>
                    <span style={{ fontFamily: 'monospace', fontSize: fontSize.sm, wordBreak: 'break-all', marginRight: 'auto' }}>
                      {f.relPath}
                    </span>
                    {f.binary && (
                      <span style={{ fontSize: fontSize.xs, color: token('textMuted') }}>
                        {t('skills.diff.binary')}
                      </span>
                    )}
                    <PickToggle value={pick} disabled={busy} onChange={(side) => setPicks((p) => ({ ...p, [f.relPath]: side }))} t={t} />
                  </div>
                  {isOpen && (
                    <div style={previewGridStyle}>
                      <PreviewColumn
                        title={t('skills.diff.library')}
                        present={sidesFor(f.status).includes('central')}
                        binary={f.binary}
                        state={contents[contentKey('central', f.relPath)]}
                        t={t}
                      />
                      <PreviewColumn
                        title={t('skills.diff.agent')}
                        present={sidesFor(f.status).includes('agent')}
                        binary={f.binary}
                        state={contents[contentKey('agent', f.relPath)]}
                        t={t}
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          <div style={{ display: 'flex', alignItems: 'center', gap: space.md, padding: '10px 14px', borderTop: `1px solid ${token('border')}` }}>
            <span style={{ fontSize: fontSize.xs, color: token('textMuted'), marginRight: 'auto' }}>
              {t('skills.diff.mergeHint')}
            </span>
            <button
              type="button"
              disabled={busy || agentPicks.length === 0}
              onClick={() => onMerge(agentPicks)}
              {...hoverBackground(token('accent'), token('accentHover'))}
              style={{
                ...accentStyle,
                fontSize: fontSize.sm,
                padding: '6px 14px',
                opacity: busy || agentPicks.length === 0 ? 0.5 : 1,
                cursor: busy || agentPicks.length === 0 ? 'default' : 'pointer',
              }}
            >
              {t('skills.diff.merge')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** A per-file "use library / use agent" segmented pick (default: library). */
function PickToggle({
  value,
  disabled,
  onChange,
  t,
}: {
  value: SkillScope;
  disabled: boolean;
  onChange: (side: SkillScope) => void;
  t: TranslateFn;
}) {
  const options: { side: SkillScope; label: string }[] = [
    { side: 'central', label: t('skills.diff.useLibrary') },
    { side: 'agent', label: t('skills.diff.useAgent') },
  ];
  return (
    <div role="group" style={segmentedStyle}>
      {options.map(({ side, label }) => {
        const active = value === side;
        return (
          <button
            key={side}
            type="button"
            aria-pressed={active}
            disabled={disabled}
            onClick={() => onChange(side)}
            style={{
              ...segmentButtonStyle,
              fontSize: fontSize.xs,
              padding: '4px 10px',
              background: active ? token('accent') : 'transparent',
              color: active ? token('accentText') : token('text'),
              cursor: disabled ? 'default' : active ? 'default' : 'pointer',
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

/** One side of the preview: a text `<pre>`, or a muted note for absent/binary/loading. */
function PreviewColumn({
  title,
  present,
  binary,
  state,
  t,
}: {
  title: string;
  present: boolean;
  binary: boolean;
  state: ContentState | undefined;
  t: TranslateFn;
}) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: fontSize.xs, fontWeight: 600, color: token('textMuted'), marginBottom: 4 }}>{title}</div>
      <PreviewBody present={present} binary={binary} state={state} t={t} />
    </div>
  );
}

function PreviewBody({
  present,
  binary,
  state,
  t,
}: {
  present: boolean;
  binary: boolean;
  state: ContentState | undefined;
  t: TranslateFn;
}) {
  const note = (text: string) => (
    <p style={{ margin: 0, fontSize: fontSize.xs, color: token('textMuted'), fontStyle: 'italic' }}>{text}</p>
  );
  if (!present) return note(t('skills.diff.previewAbsent'));
  if (binary) return note(t('skills.diff.previewBinary'));
  if (state === undefined || state === 'loading') return note(t('skills.diff.previewLoading'));
  if (state === 'error') return note(t('skills.diff.previewError'));
  if (state.binary || state.text === null) return note(t('skills.diff.previewBinary'));
  return (
    <>
      <pre style={previewPreStyle}>{state.text}</pre>
      {state.truncated && note(t('skills.diff.previewTruncated'))}
    </>
  );
}

function ActionButton({
  label,
  disabled,
  onClick,
  danger = false,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      {...hoverBackground('transparent', token('surfaceHover'))}
      style={danger ? dangerActionButtonStyle : actionButtonStyle}
    >
      {label}
    </button>
  );
}

const STATE_COLOR: Record<SkillSyncState, string> = {
  same: 'textMuted',
  'central-only': 'accent',
  'agent-only': 'accent',
  differs: 'danger',
};

function StateChip({
  state,
  newer,
  t,
}: {
  state: SkillSyncState;
  newer?: 'central' | 'agent' | null;
  t: TranslateFn;
}) {
  // When two copies differ, an arrow points the SUGGESTED sync direction, matching the
  // pull ← / push → action buttons: agent copy newer → pull ← ; library newer → push →.
  const arrow = state === 'differs' && newer ? (newer === 'agent' ? '←' : '→') : null;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: fontSize.xs,
        color: token(STATE_COLOR[state] as 'text'),
        whiteSpace: 'nowrap',
      }}
    >
      <span aria-hidden>{state === 'same' ? '✓' : state === 'differs' ? '△' : '●'}</span>
      {t(`skills.state.${stateKey(state)}`)}
      {arrow && (
        <span aria-hidden title={newer ? t(`skills.newer.${newer}`) : undefined} style={{ fontWeight: 700 }}>
          {arrow}
        </span>
      )}
    </span>
  );
}

/** The two copies' last-modified times side by side, with the newer one called out. */
function SideTimes({
  central,
  agent,
  newer,
  locale,
  t,
}: {
  central: SkillEntry | null;
  agent: SkillEntry | null;
  newer: 'central' | 'agent' | null;
  locale: Locale;
  t: TranslateFn;
}) {
  const lib = central ? formatRelative(central.modifiedAt, locale) : null;
  const ag = agent ? formatRelative(agent.modifiedAt, locale) : null;
  if (!lib && !ag) return null;
  return (
    <span style={{ fontSize: fontSize.xs, color: token('textMuted') }}>
      <span style={{ fontWeight: newer === 'central' ? 700 : 400 }}>
        {t('skills.time.library')} {lib ?? '—'}
      </span>
      {'  ·  '}
      <span style={{ fontWeight: newer === 'agent' ? 700 : 400 }}>
        {t('skills.time.agent')} {ag ?? '—'}
      </span>
      {newer && (
        <span style={{ marginLeft: 6, color: token('accent') }}>{t(`skills.newer.${newer}`)}</span>
      )}
    </span>
  );
}

/** Present/absent dot for the library column (it's the source, so no sync state). */
function StateDot({ state, t }: { state: 'present' | 'absent'; t: TranslateFn }) {
  if (state === 'absent') return <Absent />;
  return (
    <span style={{ fontSize: fontSize.xs, color: token('accent') }} title={t('skills.state.inLibrary')}>
      ●
    </span>
  );
}

function Absent() {
  return <span style={{ color: token('textMuted') }} aria-hidden>—</span>;
}

function stateKey(state: SkillSyncState): string {
  return state === 'central-only' ? 'centralOnly' : state === 'agent-only' ? 'agentOnly' : state;
}

function diffColor(status: SkillDiffResult['files'][number]['status']): string {
  return token(status === 'deleted' ? 'danger' : status === 'added' ? 'accent' : 'text');
}

// ─── styles ───────────────────────────────────────────────────────────────────

const toolbarStyle = {
  display: 'flex',
  alignItems: 'flex-end',
  gap: space.md,
  flexWrap: 'wrap',
  margin: '20px 0 16px',
} as const;

const pathButtonStyle = {
  maxWidth: 420,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  textAlign: 'left',
  padding: '4px 6px',
  borderRadius: radius.sm,
  border: 'none',
  background: 'transparent',
  color: token('text'),
  cursor: 'pointer',
  fontSize: fontSize.md,
  fontFamily: 'monospace',
} as const;

const segmentedStyle = {
  display: 'inline-flex',
  border: `1px solid ${token('border')}`,
  borderRadius: radius.md,
  overflow: 'hidden',
} as const;

const segmentButtonStyle = {
  padding: '6px 12px',
  border: 'none',
  fontSize: fontSize.sm,
} as const;

const accentStyle = {
  padding: '8px 16px',
  borderRadius: radius.md,
  border: `1px solid ${token('accent')}`,
  background: token('accent'),
  color: token('accentText'),
  cursor: 'pointer',
  fontSize: fontSize.md,
} as const;

const ghostStyle = {
  padding: '8px 16px',
  borderRadius: radius.md,
  border: `1px solid ${token('border')}`,
  background: 'transparent',
  color: token('text'),
  cursor: 'pointer',
  fontSize: fontSize.md,
} as const;

const smallGhostStyle = {
  padding: '6px 12px',
  borderRadius: radius.sm,
  border: `1px solid ${token('border')}`,
  background: 'transparent',
  color: token('text'),
  cursor: 'pointer',
  fontSize: fontSize.sm,
} as const;

const actionButtonStyle = {
  padding: '4px 10px',
  borderRadius: radius.sm,
  border: `1px solid ${token('border')}`,
  background: 'transparent',
  color: token('text'),
  cursor: 'pointer',
  fontSize: fontSize.sm,
  whiteSpace: 'nowrap',
} as const;

// Subtle danger variant for the agent-copy delete: danger-colored text on a plain
// border, matching ProviderCard's ghost-danger action — reads as "careful", not "shout".
const dangerActionButtonStyle = {
  ...actionButtonStyle,
  color: token('danger'),
} as const;

const dangerStyle = {
  padding: '6px 14px',
  borderRadius: radius.md,
  border: `1px solid ${token('danger')}`,
  background: token('danger'),
  color: token('accentText'),
  cursor: 'pointer',
  fontSize: fontSize.sm,
} as const;

const emptyStyle = {
  marginTop: 24,
  padding: '32px 24px',
  border: `1px dashed ${token('border')}`,
  borderRadius: radius.lg,
  textAlign: 'center',
} as const;

const matrixRowStyle = {
  display: 'grid',
  alignItems: 'center',
  gap: space.md,
  padding: '8px 12px',
} as const;

const headCellStyle = {
  fontSize: fontSize.sm,
  fontWeight: 600,
  color: token('textMuted'),
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
} as const;

const bodyCellStyle = {
  display: 'flex',
  alignItems: 'center',
  fontSize: fontSize.md,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
} as const;

const detailStyle = {
  marginTop: 24,
  padding: space['2xl'],
  border: `1px solid ${token('border')}`,
  borderRadius: radius.lg,
  background: token('surface'),
} as const;

const confirmBarStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: space.md,
  padding: '10px 14px',
  marginBottom: 16,
  borderRadius: radius.md,
  border: `1px solid ${token('danger')}`,
} as const;

const diffTagStyle = {
  fontSize: fontSize.xs,
  fontWeight: 600,
  textTransform: 'uppercase',
  minWidth: 64,
} as const;

const disclosureStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 20,
  height: 20,
  padding: 0,
  borderRadius: radius.sm,
  border: 'none',
  background: 'transparent',
  color: token('textMuted'),
  cursor: 'pointer',
  fontSize: fontSize.sm,
  lineHeight: 1,
} as const;

const previewGridStyle = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: space.md,
  padding: '4px 14px 12px 40px',
} as const;

const previewPreStyle = {
  margin: 0,
  padding: space.sm,
  maxHeight: 280,
  overflow: 'auto',
  borderRadius: radius.sm,
  border: `1px solid ${token('border')}`,
  background: token('surfaceHover'),
  fontFamily: 'monospace',
  fontSize: fontSize.xs,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
} as const;
