// Sessions — a reader over the agents' own session logs (Claude Code / Codex / Cursor / pi).
//
// Main scans the logs read-only; this screen lists sessions (search by title, folder,
// branch or model), opens one transcript on request, and offers main-side actions: copy the
// resume command (clipboard), export as Markdown (save dialog), and — after picking messages —
// copy or export a context pack to start a new session with. Packs are built main-side from
// the picked entry indexes. Session text is rendered as plain text only — never as HTML —
// since it is arbitrary model output.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { disabledOpacity, fontSize, radius, space, token } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import { useT, type TranslateFn } from '../../i18n';
import { ScrollTabScreen, tabScreenSectionStyle } from '../../components/TabScreenShell';
import { LoadingButton } from '../../components/ui/LoadingButton';
import { Checkbox } from '../../components/ui/Checkbox';
import { Select } from '../../components/ui/Select';
import { buttonGhostChrome, controlInputStyle } from '../../components/ui/controlStyles';
import { SESSION_AGENT_IDS } from '../../../shared/agentSessions';
import { decodeIpcError } from '../../../shared/ipc-errors';
import { agentName, sessionMatches, shortDir } from './sessionSearch';
import { packIndexes, toggleSelection } from './packSelection';
import { taskSeedFromSession, type TaskSeed } from '../workbench/taskSeed';
import type {
  SessionPackRequest,
  SessionRef,
  SessionsSnapshot,
  SessionTranscript,
  TranscriptEntry,
} from '../../../shared/agentSessions';

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
function fmtDate(ts: number): string {
  return ts > 0 ? dateFormat.format(ts) : '';
}


export function SessionsHome({
  onCreateTask,
}: {
  /** Opens the workbench's new-task form with this draft; absent when the workbench is off. */
  onCreateTask?: (seed: TaskSeed) => void;
} = {}) {
  const t = useT();
  const [snap, setSnap] = useState<SessionsSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  /** '' = every agent. */
  const [agentFilter, setAgentFilter] = useState<string>('');
  const [open, setOpen] = useState<SessionRef | null>(null);

  const load = useCallback((refresh: boolean) => {
    setLoading(true);
    setFailed(false);
    window.aiopt.sessions
      .list({ refresh })
      .then(setSnap)
      .catch(() => setFailed(true))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => load(false), [load]);

  const q = query.trim();
  const visible = useMemo(
    () => (snap ? snap.sessions.filter((s) => (!agentFilter || s.agentId === agentFilter) && sessionMatches(s, q)) : []),
    [snap, q, agentFilter],
  );
  // Every readable agent is offered (with its session count) so the list doesn't reshuffle
  // between scans; an agent with no sessions is shown disabled rather than hidden.
  const agentOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of snap?.sessions ?? []) counts.set(s.agentId, (counts.get(s.agentId) ?? 0) + 1);
    return [
      { value: '', label: `${t('sessions.allAgents')} · ${snap?.sessions.length ?? 0}` },
      ...SESSION_AGENT_IDS.map((id) => {
        const n = counts.get(id) ?? 0;
        return { value: id, label: `${agentName(id)} · ${n}`, disabled: n === 0 && agentFilter !== id };
      }),
    ];
  }, [snap, t, agentFilter]);

  if (open) {
    return (
      <ScrollTabScreen>
        <TranscriptView sessionRef={open} onBack={() => setOpen(null)} onCreateTask={onCreateTask} t={t} />
      </ScrollTabScreen>
    );
  }

  return (
    <ScrollTabScreen>
      <h1 className="sr-only">{t('sessions.title')}</h1>
      <section style={{ ...tabScreenSectionStyle, display: 'flex', gap: space.md, alignItems: 'center' }}>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('sessions.search')}
          aria-label={t('sessions.search')}
          style={{ ...controlInputStyle, flex: 1 }}
        />
        <Select
          value={agentFilter}
          onChange={setAgentFilter}
          options={agentOptions}
          disabled={!snap}
          aria-label={t('sessions.agentFilter')}
          style={{ flex: '0 0 auto', width: 180 }}
        />
        <LoadingButton variant="ghost" loading={loading} onClick={() => load(true)}>
          {t('sessions.refresh')}
        </LoadingButton>
      </section>
      <p style={{ margin: `0 0 ${space.lg}px`, fontSize: fontSize.sm, color: token('textMuted') }}>
        {t('sessions.intro')}
      </p>

      {failed ? (
        <p role="alert" style={{ fontSize: fontSize.md, color: token('danger') }}>{t('sessions.failed')}</p>
      ) : !snap ? (
        <p style={{ fontSize: fontSize.md, color: token('textMuted') }}>{t('sessions.loading')}</p>
      ) : snap.sessions.length === 0 ? (
        <p style={{ fontSize: fontSize.md, color: token('textMuted') }}>{t('sessions.empty')}</p>
      ) : visible.length === 0 ? (
        <p style={{ fontSize: fontSize.md, color: token('textMuted') }}>{t('sessions.noMatch')}</p>
      ) : (
        <ul style={listStyle}>
          {visible.map((s, i) => (
            <li key={`${s.agentId}:${s.sessionId}`} style={{ borderTop: i === 0 ? 'none' : `1px solid ${token('border')}` }}>
              <button
                type="button"
                onClick={() => setOpen({ agentId: s.agentId, sessionId: s.sessionId })}
                {...hoverBackground('transparent', token('surfaceHover'))}
                style={rowButtonStyle}
              >
                <span style={{ fontSize: fontSize.md, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {s.title || t('sessions.untitled')}
                </span>
                <span style={metaStyle}>
                  {[agentName(s.agentId), shortDir(s.cwd), s.gitBranch, fmtDate(s.updatedAt)]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {snap?.truncated && (
        <p style={{ marginTop: space.lg, fontSize: fontSize.sm, color: token('textMuted') }}>{t('sessions.truncated')}</p>
      )}
    </ScrollTabScreen>
  );
}

function TranscriptView({
  sessionRef,
  onBack,
  onCreateTask,
  t,
}: {
  sessionRef: SessionRef;
  onBack: () => void;
  onCreateTask?: (seed: TaskSeed) => void;
  t: TranslateFn;
}) {
  const [data, setData] = useState<SessionTranscript | null>(null);
  const [failed, setFailed] = useState(false);
  const [showTools, setShowTools] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<'copy' | 'export' | 'copyPack' | 'exportPack' | null>(null);
  /** Picking messages for a context pack; indexes into `data.entries`. */
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<number>>(() => new Set());
  const [anchor, setAnchor] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    window.aiopt.sessions
      .transcript(sessionRef)
      .then((d) => live && setData(d))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [sessionRef]);

  const run = (kind: 'copy' | 'export') => {
    setBusy(kind);
    setNotice(null);
    const p =
      kind === 'copy'
        ? window.aiopt.sessions.copyResume(sessionRef).then(() => t('sessions.copied'))
        : window.aiopt.sessions.export(sessionRef).then((r) => (r.saved ? t('sessions.exported') : null));
    p.then(setNotice)
      .catch(() => setNotice(t('sessions.actionFailed')))
      .finally(() => setBusy(null));
  };

  // Indexes into the full entry list, so a pick survives toggling tool calls on and off.
  const shown = useMemo(
    () => (data ? data.entries.map((e, i) => ({ e, i })).filter(({ e }) => showTools || e.role !== 'tool') : []),
    [data, showTools],
  );
  const shownIndexes = useMemo(() => shown.map(({ i }) => i), [shown]);
  const pack = packIndexes(picked, shownIndexes);
  const s = data?.session;

  const pick = (index: number, range: boolean) => {
    setPicked((cur) => toggleSelection(cur, index, { range, anchor, visible: shownIndexes }));
    setAnchor(index);
  };

  const stopPicking = () => {
    setPicking(false);
    setPicked(new Set());
    setAnchor(null);
  };

  const runPack = (kind: 'copyPack' | 'exportPack') => {
    if (!data || pack.length === 0) return;
    const request: SessionPackRequest = {
      ...sessionRef,
      indexes: pack,
      total: data.entries.length,
      firstTs: data.entries[0]?.ts ?? 0,
    };
    setBusy(kind);
    setNotice(null);
    const p = kind === 'copyPack' ? window.aiopt.sessions.copyPack(request) : window.aiopt.sessions.exportPack(request);
    p.then((r) => {
      if (!r.saved) return null;
      const done = fill(t(kind === 'copyPack' ? 'sessions.pack.copied' : 'sessions.pack.exported'), { count: r.included });
      return r.cut ? `${done} ${t('sessions.pack.cut')}` : done;
    })
      .then(setNotice)
      .catch((err: unknown) => setNotice(isStale(err) ? t('sessions.pack.stale') : t('sessions.actionFailed')))
      .finally(() => setBusy(null));
  };

  return (
    <>
      <section style={{ ...tabScreenSectionStyle, display: 'flex', alignItems: 'center', gap: space.md, flexWrap: 'wrap' }}>
        <button type="button" onClick={onBack} {...hoverBackground('transparent', token('surfaceHover'))} style={buttonGhostChrome('md')}>
          {t('sessions.back')}
        </button>
        <div style={{ flex: 1 }} />
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: space.sm, fontSize: fontSize.md }}>
          <Checkbox id="sessions-show-tools" checked={showTools} onChange={setShowTools} aria-label={t('sessions.showTools')} />
          <label htmlFor="sessions-show-tools">{t('sessions.showTools')}</label>
        </span>
        <button
          type="button"
          aria-pressed={picking}
          disabled={!data || data.entries.length === 0}
          onClick={() => (picking ? stopPicking() : setPicking(true))}
          {...hoverBackground(picking ? token('surfaceHover') : 'transparent', token('surfaceHover'))}
          style={{ ...buttonGhostChrome('md'), opacity: !data || data.entries.length === 0 ? disabledOpacity : 1 }}
        >
          {picking ? t('sessions.pack.done') : t('sessions.pack.start')}
        </button>
        {onCreateTask && (
          <button
            type="button"
            disabled={!s}
            title={t('sessions.newTaskHint')}
            onClick={() => s && onCreateTask(taskSeedFromSession(s, t('sessions.untitled')))}
            {...hoverBackground('transparent', token('surfaceHover'))}
            style={{ ...buttonGhostChrome('md'), opacity: s ? 1 : disabledOpacity }}
          >
            {t('sessions.newTask')}
          </button>
        )}
        <LoadingButton variant="ghost" loading={busy === 'copy'} disabled={!data} onClick={() => run('copy')}>
          {t('sessions.copyResume')}
        </LoadingButton>
        <LoadingButton variant="accent" loading={busy === 'export'} disabled={!data} onClick={() => run('export')}>
          {t('sessions.export')}
        </LoadingButton>
      </section>
      {picking && data && (
        <section aria-label={t('sessions.pack.title')} style={packBarStyle}>
          <span style={{ fontSize: fontSize.md, fontVariantNumeric: 'tabular-nums' }}>
            {fill(t('sessions.pack.selected'), { count: pack.length })}
          </span>
          <button
            type="button"
            onClick={() => setPicked(new Set(shownIndexes))}
            {...hoverBackground('transparent', token('surfaceHover'))}
            style={buttonGhostChrome('sm')}
          >
            {t('sessions.pack.all')}
          </button>
          <button
            type="button"
            disabled={pack.length === 0}
            onClick={() => setPicked(new Set())}
            {...hoverBackground('transparent', token('surfaceHover'))}
            style={{ ...buttonGhostChrome('sm'), opacity: pack.length === 0 ? disabledOpacity : 1 }}
          >
            {t('sessions.pack.clear')}
          </button>
          <span style={{ flex: 1, minWidth: 0, fontSize: fontSize.sm, color: token('textMuted') }}>{t('sessions.pack.hint')}</span>
          <LoadingButton variant="ghost" size="sm" loading={busy === 'exportPack'} disabled={pack.length === 0} onClick={() => runPack('exportPack')}>
            {t('sessions.pack.export')}
          </LoadingButton>
          <LoadingButton variant="accent" size="sm" loading={busy === 'copyPack'} disabled={pack.length === 0} onClick={() => runPack('copyPack')}>
            {t('sessions.pack.copy')}
          </LoadingButton>
        </section>
      )}
      {notice && (
        <p role="status" style={{ margin: `0 0 ${space.lg}px`, fontSize: fontSize.sm, color: token('textMuted') }}>
          {notice}
        </p>
      )}

      {failed ? (
        <p role="alert" style={{ fontSize: fontSize.md, color: token('danger') }}>{t('sessions.failed')}</p>
      ) : !data || !s ? (
        <p style={{ fontSize: fontSize.md, color: token('textMuted') }}>{t('sessions.loading')}</p>
      ) : (
        <>
          <h2 style={{ margin: `0 0 ${space.xs}px`, fontSize: fontSize['2xl'], fontWeight: 600, overflowWrap: 'anywhere' }}>
            {s.title || t('sessions.untitled')}
          </h2>
          <p style={{ ...metaStyle, margin: `0 0 ${space.xl}px` }}>
            {[agentName(s.agentId), s.cwd, s.gitBranch, s.model, fmtDate(s.startedAt)].filter(Boolean).join(' · ')}
          </p>
          {data.truncated && (
            <p style={{ margin: `0 0 ${space.lg}px`, fontSize: fontSize.sm, color: token('textMuted') }}>
              {t('sessions.transcriptTruncated')}
            </p>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: space.lg }}>
            {shown.map(({ e, i }) => (
              <Entry
                key={i}
                entry={e}
                t={t}
                pick={picking ? { checked: picked.has(i), onPick: (range) => pick(i, range) } : undefined}
              />
            ))}
          </div>
        </>
      )}
    </>
  );
}

function Entry({
  entry,
  t,
  pick,
}: {
  entry: TranscriptEntry;
  t: TranslateFn;
  /** Set while picking messages for a context pack. */
  pick?: { checked: boolean; onPick: (range: boolean) => void };
}) {
  const label =
    entry.role === 'tool'
      ? entry.toolName
        ? `${t('sessions.role.tool')} · ${entry.toolName}`
        : t('sessions.role.tool')
      : t(`sessions.role.${entry.role}`);
  const isUser = entry.role === 'user';
  const checked = pick?.checked === true;
  return (
    <article
      // While picking, a click anywhere on the message toggles it (Shift extends a range);
      // the checkbox is the keyboard path. Text selection still works with a drag.
      onClick={
        pick
          ? (e) => {
              if (window.getSelection()?.toString()) return;
              if ((e.target as HTMLElement).closest('button')) return;
              pick.onPick(e.shiftKey);
            }
          : undefined
      }
      style={{
        border: `1px solid ${checked ? token('accent') : token('border')}`,
        borderRadius: radius.lg,
        background: isUser ? token('surface') : token('bg'),
        padding: space.lg,
        cursor: pick ? 'pointer' : undefined,
        boxShadow: checked ? `inset 0 0 0 1px ${token('accent')}` : undefined,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: space.sm, fontSize: fontSize.sm, color: token('textMuted'), marginBottom: space.sm }}>
        {pick && (
          <span
            onClick={(e) => {
              e.stopPropagation();
              pick.onPick(e.shiftKey);
            }}
            style={{ display: 'inline-flex' }}
          >
            <Checkbox checked={checked} onChange={() => {}} aria-label={fill(t('sessions.pack.pickOne'), { role: label })} />
          </span>
        )}
        <span>{label}</span>
      </div>
      <div
        style={{
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
          fontSize: entry.role === 'tool' ? fontSize.sm : fontSize.md,
          fontFamily: entry.role === 'tool' ? 'ui-monospace, monospace' : undefined,
          color: entry.role === 'tool' ? token('textMuted') : token('text'),
        }}
      >
        {entry.text}
      </div>
    </article>
  );
}

const listStyle = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  border: `1px solid ${token('border')}`,
  borderRadius: radius.lg,
  overflow: 'hidden',
  background: token('bg'),
} as const;

const rowButtonStyle = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: 2,
  width: '100%',
  padding: `${space.md}px ${space.lg}px`,
  border: 'none',
  background: 'transparent',
  color: token('text'),
  textAlign: 'left',
  cursor: 'pointer',
  minWidth: 0,
} as const;

const packBarStyle = {
  ...tabScreenSectionStyle,
  display: 'flex',
  alignItems: 'center',
  gap: space.md,
  flexWrap: 'wrap',
  position: 'sticky',
  top: 0,
  zIndex: 5,
  padding: `${space.md}px ${space.lg}px`,
  border: `1px solid ${token('border')}`,
  borderRadius: radius.lg,
  background: token('surface'),
} as const;

function isStale(err: unknown): boolean {
  return err instanceof Error && decodeIpcError(err.message).code === 'PRECONDITION_FAILED';
}

function fill(text: string, vars: Record<string, string | number>): string {
  return Object.entries(vars).reduce((s, [k, v]) => s.replace(`{{${k}}}`, String(v)), text);
}

const metaStyle = {
  fontSize: fontSize.sm,
  color: token('textMuted'),
  overflowWrap: 'anywhere',
} as const;
