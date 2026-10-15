// Sessions — a reader over the agents' own session logs (Claude Code / Codex).
//
// Main scans the logs read-only; this screen lists sessions (search by title, folder,
// branch or model), opens one transcript on request, and offers two main-side actions:
// copy the resume command (clipboard) and export as Markdown (save dialog). Session text
// is rendered as plain text only — never as HTML — since it is arbitrary model output.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { fontSize, radius, space, token } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import { useT, type TranslateFn } from '../../i18n';
import { ScrollTabScreen, tabScreenSectionStyle } from '../../components/TabScreenShell';
import { LoadingButton } from '../../components/ui/LoadingButton';
import { Checkbox } from '../../components/ui/Checkbox';
import { buttonGhostChrome, controlInputStyle } from '../../components/ui/controlStyles';
import { AGENTS } from '../../../shared/aiProviders';
import type {
  SessionRef,
  SessionSummary,
  SessionsSnapshot,
  SessionTranscript,
  TranscriptEntry,
} from '../../../shared/agentSessions';

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
function fmtDate(ts: number): string {
  return ts > 0 ? dateFormat.format(ts) : '';
}

const agentName = (id: string): string => AGENTS.find((a) => a.id === id)?.name ?? id;

/** Show the last two path segments — enough to recognise a project. */
function shortDir(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? cwd : `…/${parts.slice(-2).join('/')}`;
}

function matches(s: SessionSummary, q: string): boolean {
  if (!q) return true;
  return [s.title, s.cwd, s.gitBranch, s.model, s.sessionId].some((f) => f.toLowerCase().includes(q));
}

export function SessionsHome() {
  const t = useT();
  const [snap, setSnap] = useState<SessionsSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
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

  const q = query.trim().toLowerCase();
  const visible = useMemo(() => (snap ? snap.sessions.filter((s) => matches(s, q)) : []), [snap, q]);

  if (open) {
    return (
      <ScrollTabScreen>
        <TranscriptView sessionRef={open} onBack={() => setOpen(null)} t={t} />
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

function TranscriptView({ sessionRef, onBack, t }: { sessionRef: SessionRef; onBack: () => void; t: TranslateFn }) {
  const [data, setData] = useState<SessionTranscript | null>(null);
  const [failed, setFailed] = useState(false);
  const [showTools, setShowTools] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<'copy' | 'export' | null>(null);

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

  const entries = data ? data.entries.filter((e) => showTools || e.role !== 'tool') : [];
  const s = data?.session;

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
        <LoadingButton variant="ghost" loading={busy === 'copy'} disabled={!data} onClick={() => run('copy')}>
          {t('sessions.copyResume')}
        </LoadingButton>
        <LoadingButton variant="accent" loading={busy === 'export'} disabled={!data} onClick={() => run('export')}>
          {t('sessions.export')}
        </LoadingButton>
      </section>
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
            {entries.map((e, i) => (
              <Entry key={i} entry={e} t={t} />
            ))}
          </div>
        </>
      )}
    </>
  );
}

function Entry({ entry, t }: { entry: TranscriptEntry; t: TranslateFn }) {
  const label =
    entry.role === 'tool'
      ? entry.toolName
        ? `${t('sessions.role.tool')} · ${entry.toolName}`
        : t('sessions.role.tool')
      : t(`sessions.role.${entry.role}`);
  const isUser = entry.role === 'user';
  return (
    <article
      style={{
        border: `1px solid ${token('border')}`,
        borderRadius: radius.lg,
        background: isUser ? token('surface') : token('bg'),
        padding: space.lg,
      }}
    >
      <div style={{ fontSize: fontSize.sm, color: token('textMuted'), marginBottom: space.sm }}>{label}</div>
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

const metaStyle = {
  fontSize: fontSize.sm,
  color: token('textMuted'),
  overflowWrap: 'anywhere',
} as const;
