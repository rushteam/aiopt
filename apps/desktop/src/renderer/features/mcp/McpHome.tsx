// MCP — one library of MCP servers, synced into each agent's own MCP config.
//
// The library lives in main. This screen lists servers with a per-agent on/off checkbox
// and drift state, edits a server in a modal form, and offers to import servers already
// present in an agent config. Env/header VALUES are write-only here: the form sends a new
// value or nothing ("keep"), and main never sends one back. Saving or enabling a server
// opens main's native confirmation; a declined write comes back as `saved: false`.

import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { elevation, fontSize, radius, space, token } from '../../themes/tokens';
import { useT, type TranslateFn } from '../../i18n';
import { ScrollTabScreen, tabScreenSectionStyle } from '../../components/TabScreenShell';
import { LoadingButton } from '../../components/ui/LoadingButton';
import { Checkbox } from '../../components/ui/Checkbox';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import {
  buttonAccentChrome,
  buttonGhostChrome,
  controlInputStyle,
  segmentButtonChrome,
  segmentedRootStyle,
} from '../../components/ui/controlStyles';
import { AGENT_SPECS } from '../../../shared/aiProviders';
import { ipcErrorFromUnknown } from '../../../shared/ipc-errors';
import {
  MCP_AGENT_IDS,
  MCP_TRANSPORTS,
  agentSupportsTransport,
  isMcpName,
  mcpSummary,
  type McpAgentId,
  type McpAgentState,
  type McpSaveRequest,
  type McpServerView,
  type McpSnapshot,
  type McpTransport,
} from '../../../shared/mcp';

const mono = 'ui-monospace, monospace';

function errorText(t: TranslateFn, err: unknown): string {
  const { code } = ipcErrorFromUnknown(err);
  const key = `mcp.errors.${code}`;
  const translated = t(key);
  return translated !== key ? translated : t('mcp.errors.generic');
}

export function McpHome() {
  const t = useT();
  const [snap, setSnap] = useState<McpSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [editing, setEditing] = useState<McpServerView | 'new' | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = useCallback(() => {
    setFailed(false);
    window.aiopt.mcp
      .get()
      .then(setSnap)
      .catch(() => setFailed(true));
  }, []);
  useEffect(load, [load]);

  /** Run one action; `saved: false` from a write means the user declined the dialog. */
  const run = useCallback(
    async (key: string, action: () => Promise<McpSnapshot | { saved: boolean; snapshot: McpSnapshot }>) => {
      setBusy(key);
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
        setBusy(null);
      }
    },
    [t],
  );

  const unreadable = snap?.agents.filter((a) => a.unreadable) ?? [];

  return (
    <ScrollTabScreen>
      <h1 className="sr-only">{t('mcp.title')}</h1>
      <section style={{ ...tabScreenSectionStyle, display: 'flex', gap: space.md, alignItems: 'center' }}>
        <p style={{ margin: 0, flex: 1, fontSize: fontSize.sm, color: token('textMuted') }}>{t('mcp.intro')}</p>
        <button type="button" onClick={load} style={buttonGhostChrome('md')}>
          {t('mcp.refresh')}
        </button>
        <button type="button" onClick={() => setEditing('new')} style={buttonAccentChrome('md')}>
          {t('mcp.add')}
        </button>
      </section>

      {notice && (
        <p role={notice.error ? 'alert' : 'status'} style={{ margin: `0 0 ${space.lg}px`, fontSize: fontSize.sm, color: token(notice.error ? 'danger' : 'textMuted') }}>
          {notice.text}
        </p>
      )}
      {snap && !snap.secretsAvailable && (
        <p style={warnStyle}>{t('mcp.secretsUnavailable')}</p>
      )}
      {unreadable.map((a) => (
        <p key={a.agentId} style={warnStyle}>
          {t('mcp.unreadable').replace('{{agent}}', AGENT_SPECS[a.agentId].name).replace('{{path}}', a.configDisplayPath)}
        </p>
      ))}

      {failed ? (
        <p role="alert" style={{ fontSize: fontSize.md, color: token('danger') }}>{t('mcp.failed')}</p>
      ) : !snap ? (
        <p style={{ fontSize: fontSize.md, color: token('textMuted') }}>{t('mcp.loading')}</p>
      ) : (
        <>
          {snap.servers.length === 0 ? (
            <p style={{ fontSize: fontSize.md, color: token('textMuted') }}>{t('mcp.empty')}</p>
          ) : (
            <ul style={listStyle}>
              {snap.servers.map((s, i) => (
                <ServerRow
                  key={s.name}
                  server={s}
                  first={i === 0}
                  busy={busy}
                  t={t}
                  onToggle={(agentId, enabled) =>
                    void run(`toggle:${s.name}:${agentId}`, () => window.aiopt.mcp.toggle(s.name, agentId, enabled))
                  }
                  onResync={() => void run(`resync:${s.name}`, () => window.aiopt.mcp.resync(s.name))}
                  onEdit={() => setEditing(s)}
                  onDelete={() => setDeleting(s.name)}
                />
              ))}
            </ul>
          )}
          <p style={{ margin: `${space.md}px 0 0`, fontSize: fontSize.xs, color: token('textMuted') }}>
            {t('mcp.files')}{' '}
            {snap.agents.map((a) => `${AGENT_SPECS[a.agentId].name} ${a.configDisplayPath}`).join(' · ')}
          </p>
          <p style={{ margin: `${space.xs}px 0 0`, fontSize: fontSize.xs, color: token('textMuted') }}>{t('mcp.claudeNote')}</p>

          {snap.candidates.length > 0 && (
            <section style={{ marginTop: space['2xl'] }}>
              <h2 style={{ margin: `0 0 ${space.sm}px`, fontSize: fontSize.lg }}>{t('mcp.importTitle')}</h2>
              <p style={{ margin: `0 0 ${space.md}px`, fontSize: fontSize.sm, color: token('textMuted') }}>{t('mcp.importIntro')}</p>
              <ul style={listStyle}>
                {snap.candidates.map((c, i) => (
                  <li key={`${c.agentId}:${c.name}`} style={{ ...rowStyle, borderTop: i === 0 ? 'none' : `1px solid ${token('border')}` }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: fontSize.md, fontWeight: 500 }}>
                        {c.name} <span style={badgeStyle}>{c.transport}</span>
                      </div>
                      <div style={summaryStyle}>{`${AGENT_SPECS[c.agentId].name} · ${c.summary}`}</div>
                    </div>
                    <LoadingButton
                      variant="ghost"
                      size="sm"
                      loading={busy === `import:${c.agentId}:${c.name}`}
                      disabled={busy !== null || snap.servers.some((s) => s.name === c.name)}
                      onClick={() => void run(`import:${c.agentId}:${c.name}`, () => window.aiopt.mcp.import(c.agentId, c.name))}
                    >
                      {t('mcp.import')}
                    </LoadingButton>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      {editing && snap && (
        <ServerForm
          initial={editing === 'new' ? null : editing}
          existingNames={snap.servers.map((s) => s.name)}
          secretsAvailable={snap.secretsAvailable}
          t={t}
          onClose={() => setEditing(null)}
          onSave={async (req) => {
            let saved = false;
            const ok = await run('save', async () => {
              const r = await window.aiopt.mcp.save(req);
              saved = r.saved;
              return r;
            });
            if (ok && saved) setEditing(null);
          }}
          saving={busy === 'save'}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={t('mcp.deleteTitle').replace('{{name}}', deleting)}
          message={t('mcp.deleteMessage')}
          confirmLabel={t('mcp.delete')}
          cancelLabel={t('mcp.cancel')}
          danger
          busy={busy === 'delete'}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const name = deleting;
            void run('delete', () => window.aiopt.mcp.delete(name)).then(() => setDeleting(null));
          }}
        />
      )}
    </ScrollTabScreen>
  );
}

function ServerRow({
  server: s,
  first,
  busy,
  t,
  onToggle,
  onResync,
  onEdit,
  onDelete,
}: {
  server: McpServerView;
  first: boolean;
  busy: string | null;
  t: TranslateFn;
  onToggle: (agentId: McpAgentId, enabled: boolean) => void;
  onResync: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const drift = MCP_AGENT_IDS.some((a) => s.agents[a] === 'missing' || s.agents[a] === 'different');
  const keys = [...s.env, ...s.headers];
  return (
    <li style={{ ...rowStyle, alignItems: 'flex-start', borderTop: first ? 'none' : `1px solid ${token('border')}` }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: fontSize.md, fontWeight: 500 }}>
          {s.name} <span style={badgeStyle}>{s.transport}</span>
        </div>
        <div style={summaryStyle} title={mcpSummary(s)}>{mcpSummary(s)}</div>
        {keys.length > 0 && (
          <div style={{ fontSize: fontSize.xs, color: token('textMuted'), marginTop: space.xs }}>
            {keys.map((k) => (k.set ? k.key : `${k.key} (${t('mcp.valueMissing')})`)).join(', ')}
          </div>
        )}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: space.lg, marginTop: space.md }}>
          {MCP_AGENT_IDS.map((agentId) => {
            const supported = agentSupportsTransport(agentId, s.transport);
            const state = s.agents[agentId];
            const id = `mcp-${s.name}-${agentId}`;
            return (
              <span key={agentId} style={{ display: 'inline-flex', alignItems: 'center', gap: space.sm, fontSize: fontSize.sm }}>
                <Checkbox
                  id={id}
                  checked={state !== 'off'}
                  disabled={!supported || busy !== null}
                  onChange={(next) => onToggle(agentId, next)}
                />
                <label htmlFor={id} style={{ color: supported ? token('text') : token('textMuted') }}>
                  {AGENT_SPECS[agentId].name}
                </label>
                <StateLabel state={supported ? state : null} t={t} />
              </span>
            );
          })}
        </div>
      </div>
      <div style={{ display: 'flex', gap: space.sm, flexShrink: 0 }}>
        {drift && (
          <LoadingButton variant="ghost" size="sm" loading={busy === `resync:${s.name}`} disabled={busy !== null} onClick={onResync}>
            {t('mcp.resync')}
          </LoadingButton>
        )}
        <button type="button" onClick={onEdit} disabled={busy !== null} style={buttonGhostChrome('sm')}>
          {t('mcp.edit')}
        </button>
        <button type="button" onClick={onDelete} disabled={busy !== null} style={{ ...buttonGhostChrome('sm'), color: token('danger') }}>
          {t('mcp.delete')}
        </button>
      </div>
    </li>
  );
}

function StateLabel({ state, t }: { state: McpAgentState | null; t: TranslateFn }) {
  if (state === null) return <span style={{ color: token('textMuted'), fontSize: fontSize.xs }}>{t('mcp.state.unsupported')}</span>;
  if (state === 'off' || state === 'synced') return null;
  return <span style={{ color: token('danger'), fontSize: fontSize.xs }}>{t(`mcp.state.${state}`)}</span>;
}

interface VarRow {
  key: string;
  /** Empty string with `stored` → keep the stored value. */
  value: string;
  stored: boolean;
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
  const toRows = (list: McpServerView['env']): VarRow[] => list.map((v) => ({ key: v.key, value: '', stored: v.set }));
  const [env, setEnv] = useState<VarRow[]>(toRows(initial?.env ?? []));
  const [headers, setHeaders] = useState<VarRow[]>(toRows(initial?.headers ?? []));
  const [agents, setAgents] = useState<Set<McpAgentId>>(
    new Set(initial ? MCP_AGENT_IDS.filter((a) => initial.agents[a] !== 'off') : []),
  );

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
      agents: MCP_AGENT_IDS.filter((a) => agents.has(a) && agentSupportsTransport(a, transport)),
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
                  type="password"
                  value={v.value}
                  aria-label={t('mcp.form.value')}
                  placeholder={v.stored ? t('mcp.form.valueKeep') : t('mcp.form.value')}
                  onChange={(e) => setVars(vars.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                  style={{ ...controlInputStyle, flex: 1 }}
                  autoComplete="off"
                />
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
              <button type="button" onClick={() => setVars([...vars, { key: '', value: '', stored: false }])} style={buttonGhostChrome('sm')}>
                {t('mcp.form.addVar')}
              </button>
            </div>
            {needsSecret && !secretsAvailable && <span style={hintErrorStyle}>{t('mcp.secretsUnavailable')}</span>}
            <span style={{ fontSize: fontSize.xs }}>{t('mcp.form.valuesNote')}</span>
          </div>
          <div style={fieldStyle}>
            <span>{t('mcp.form.agents')}</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: space.lg }}>
              {MCP_AGENT_IDS.map((agentId) => {
                const supported = agentSupportsTransport(agentId, transport);
                const id = `mcp-form-agent-${agentId}`;
                return (
                  <span key={agentId} style={{ display: 'inline-flex', alignItems: 'center', gap: space.sm, color: token('text') }}>
                    <Checkbox
                      id={id}
                      checked={supported && agents.has(agentId)}
                      disabled={!supported}
                      onChange={(next) => {
                        const n = new Set(agents);
                        if (next) n.add(agentId);
                        else n.delete(agentId);
                        setAgents(n);
                      }}
                    />
                    <label htmlFor={id} style={{ color: supported ? token('text') : token('textMuted') }}>
                      {AGENT_SPECS[agentId].name}
                      {!supported && ` (${t('mcp.state.unsupported')})`}
                    </label>
                  </span>
                );
              })}
            </div>
            <span style={{ fontSize: fontSize.xs }}>{t('mcp.form.confirmNote')}</span>
          </div>
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

const listStyle: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  border: `1px solid ${token('border')}`,
  borderRadius: radius.lg,
  background: token('surface'),
};

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: space.lg,
  padding: `${space.lg}px ${space.xl}px`,
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
