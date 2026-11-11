// What a task changed, read-only: the files of its checkout against the commit it started
// from, each expandable into its diff. Main picks the checkout from its own task record and
// caps what it returns; nothing here writes, merges, or reverts.

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { fontSize, radius, space, token } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import type { TranslateFn } from '../../i18n';
import { readTaskChanges } from '../../lib/workbenchStore';
import { ipcErrorFromUnknown } from '../../../shared/ipc-errors';
import type { TaskChangedFile, TaskChanges, TaskChangeStatus, TaskView } from '../../../shared/workbench';
import { changeTotals, diffRows, type DiffRow } from './diffView';
import { ChevronIcon, RefreshIcon } from './workbenchIcons';

type State =
  { kind: 'loading' } | { kind: 'ready'; changes: TaskChanges } | { kind: 'unavailable' } | { kind: 'error' };

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

const STATUS_MARK: Record<TaskChangeStatus, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
};

export function TaskChangesPane({ task, t }: { task: TaskView; t: TranslateFn }) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const seq = useRef(0);

  const load = useCallback(() => {
    const mine = ++seq.current;
    setState((s) => (s.kind === 'ready' ? s : { kind: 'loading' }));
    readTaskChanges(task.id)
      .then((changes) => {
        if (mine === seq.current) setState({ kind: 'ready', changes });
      })
      .catch((err: unknown) => {
        if (mine !== seq.current) return;
        setState({ kind: ipcErrorFromUnknown(err).code === 'PRECONDITION_FAILED' ? 'unavailable' : 'error' });
      });
  }, [task.id]);

  // Re-read when the task moves (a worker stopping for review is when its changes matter).
  useEffect(() => {
    load();
  }, [load, task.status]);

  useEffect(() => {
    setOpen(new Set());
  }, [task.id]);

  const toggle = (path: string): void =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const changes = state.kind === 'ready' ? state.changes : null;
  const totals = useMemo(() => (changes ? changeTotals(changes.files) : null), [changes]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      <div style={barStyle}>
        <span style={{ fontSize: fontSize.sm, color: token('textMuted'), minWidth: 0, flex: 1 }}>
          {changes && totals ? (
            <>
              {t('workbench.changes.files').replace('{{count}}', String(changes.files.length))}
              {changes.files.length > 0 && (
                <>
                  {' · '}
                  <span style={{ color: token('success') }}>+{totals.additions}</span>{' '}
                  <span style={{ color: token('danger') }}>−{totals.deletions}</span>
                </>
              )}
              {' · '}
              {changes.since === 'launch'
                ? task.isolated
                  ? t('workbench.changes.sinceLaunch')
                  : t('workbench.changes.sinceLaunchInPlace')
                : t('workbench.changes.sinceHead')}
            </>
          ) : null}
        </span>
        <button
          type="button"
          aria-label={t('workbench.changes.refresh')}
          title={t('workbench.changes.refresh')}
          onClick={load}
          {...hoverBackground('transparent', token('surfaceHover'))}
          style={iconButtonStyle}
        >
          <RefreshIcon size={14} />
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {state.kind === 'loading' && <p style={hintStyle}>{t('workbench.changes.loading')}</p>}
        {state.kind === 'unavailable' && <p style={hintStyle}>{t('workbench.changes.unavailable')}</p>}
        {state.kind === 'error' && (
          <p style={{ ...hintStyle, color: token('danger') }}>{t('workbench.changes.error')}</p>
        )}
        {changes && changes.files.length === 0 && <p style={hintStyle}>{t('workbench.changes.empty')}</p>}
        {changes && changes.truncated && <p style={hintStyle}>{t('workbench.changes.truncated')}</p>}
        {changes && changes.files.length > 0 && (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {changes.files.map((f) => (
              <FileRow key={f.path} file={f} open={open.has(f.path)} onToggle={() => toggle(f.path)} t={t} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function FileRow({
  file,
  open,
  onToggle,
  t,
}: {
  file: TaskChangedFile;
  open: boolean;
  onToggle: () => void;
  t: TranslateFn;
}) {
  const rows = useMemo(() => (open && file.patch ? diffRows(file.patch) : []), [open, file.patch]);
  const markColor =
    file.status === 'deleted'
      ? token('danger')
      : file.status === 'modified' || file.status === 'renamed'
        ? token('warning')
        : token('success');
  const label = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
  return (
    <li style={{ borderBottom: `1px solid ${token('border')}` }}>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        title={label}
        {...hoverBackground('transparent', token('surfaceHover'))}
        style={rowStyle}
      >
        <ChevronIcon open={open} />
        <span
          aria-label={t(`workbench.changes.status.${file.status}`)}
          title={t(`workbench.changes.status.${file.status}`)}
          style={{ fontFamily: MONO, fontSize: fontSize.xs, color: markColor, width: 12, flexShrink: 0 }}
        >
          {STATUS_MARK[file.status]}
        </span>
        <span style={pathStyle}>{label}</span>
        {file.additions !== null && file.deletions !== null ? (
          <span style={{ fontFamily: MONO, fontSize: fontSize.xs, flexShrink: 0 }}>
            <span style={{ color: token('success') }}>+{file.additions}</span>{' '}
            <span style={{ color: token('danger') }}>−{file.deletions}</span>
          </span>
        ) : (
          <span style={{ fontSize: fontSize.xs, color: token('textMuted'), flexShrink: 0 }}>
            {t('workbench.changes.binary')}
          </span>
        )}
      </button>
      {open && (
        <div style={patchBoxStyle}>
          {file.patch === null || rows.length === 0 ? (
            <p style={{ ...hintStyle, padding: `${space.xs}px ${space.md}px` }}>
              {file.additions === null
                ? t('workbench.changes.binary')
                : file.additions === 0 && file.deletions === 0
                  ? t('workbench.changes.noContent')
                  : t('workbench.changes.noPatch')}
            </p>
          ) : (
            <table style={tableStyle}>
              <tbody>
                {rows.map((r, i) => (
                  <DiffLine key={i} row={r} />
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </li>
  );
}

function DiffLine({ row }: { row: DiffRow }) {
  if (row.kind === 'hunk' || row.kind === 'note') {
    return (
      <tr>
        <td colSpan={3} style={{ ...cellStyle, color: token('textMuted'), padding: `2px ${space.md}px` }}>
          {row.text}
        </td>
      </tr>
    );
  }
  const color = row.kind === 'add' ? token('success') : row.kind === 'del' ? token('danger') : token('text');
  const sign = row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' ';
  return (
    <tr>
      <td style={numStyle}>{row.oldNo ?? ''}</td>
      <td style={numStyle}>{row.newNo ?? ''}</td>
      <td style={{ ...cellStyle, color }}>
        <span aria-hidden style={{ display: 'inline-block', width: '1.2em', userSelect: 'none' }}>
          {sign}
        </span>
        {row.text}
      </td>
    </tr>
  );
}

const barStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: space.sm,
  padding: `${space.xs}px ${space.md}px`,
  borderBottom: `1px solid ${token('border')}`,
  flexShrink: 0,
};

const iconButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 24,
  height: 24,
  padding: 0,
  border: 'none',
  borderRadius: radius.sm,
  background: 'transparent',
  color: token('textMuted'),
  cursor: 'pointer',
  flexShrink: 0,
};

const hintStyle: CSSProperties = {
  margin: 0,
  padding: `${space.sm}px ${space.md}px`,
  fontSize: fontSize.sm,
  color: token('textMuted'),
};

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: space.sm,
  width: '100%',
  padding: `${space.xs}px ${space.md}px`,
  border: 'none',
  background: 'transparent',
  color: token('text'),
  cursor: 'pointer',
  textAlign: 'left',
  fontSize: fontSize.sm,
};

const pathStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontFamily: MONO,
  fontSize: fontSize.sm,
  direction: 'rtl',
  textAlign: 'left',
  unicodeBidi: 'plaintext',
};

const patchBoxStyle: CSSProperties = {
  overflowX: 'auto',
  background: token('surface'),
  borderTop: `1px solid ${token('border')}`,
};

const tableStyle: CSSProperties = {
  borderCollapse: 'collapse',
  minWidth: '100%',
  fontFamily: MONO,
  fontSize: fontSize.xs,
  lineHeight: 1.5,
};

const cellStyle: CSSProperties = {
  padding: `0 ${space.md}px 0 ${space.xs}px`,
  whiteSpace: 'pre',
  verticalAlign: 'top',
};

const numStyle: CSSProperties = {
  padding: `0 ${space.xs}px`,
  textAlign: 'right',
  color: token('textMuted'),
  userSelect: 'none',
  verticalAlign: 'top',
  minWidth: 32,
  whiteSpace: 'nowrap',
};
