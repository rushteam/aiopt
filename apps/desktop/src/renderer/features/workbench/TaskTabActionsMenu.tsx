import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { elevation, fontSize, radius, space, token } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import type { TranslateFn } from '../../i18n';
import { taskAllows, type FolderView, type TaskView, type WorkbenchSnapshot } from '../../../shared/workbench';
import { removeTask, updateTask } from '../../lib/workbenchStore';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { TASK_TAB_HEIGHT, TASK_TAB_MARGIN_BOTTOM, TASK_TAB_MARGIN_TOP } from './taskTabChrome';

type Runner = (action: () => Promise<void>) => Promise<boolean>;

export function TaskTabActionsMenu({
  task,
  wb,
  t,
  run,
  onEdit,
  rail,
}: {
  task: TaskView;
  wb: WorkbenchSnapshot;
  t: TranslateFn;
  run: Runner;
  onEdit: () => void;
  /** Compact control on the vertical task rail. */
  rail?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (rootRef.current?.contains(target)) return;
      if (buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const timer = window.setTimeout(() => {
      document.addEventListener('pointerdown', onPointerDown);
      document.addEventListener('keydown', onKeyDown);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const placeLocked = task.worktreeDisplay !== null;
  const editable = taskAllows('edit', task.status);
  const canRemove = taskAllows('remove', task.status);

  useEffect(() => {
    setOpen(false);
  }, [task.id]);

  const toggleMenu = (e: MouseEvent): void => {
    e.stopPropagation();
    e.preventDefault();
    if (open) {
      setOpen(false);
      return;
    }
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) {
      const width = 260;
      setMenuPos({
        top: rect.bottom + 2,
        left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
      });
    }
    setOpen(true);
  };

  const menu =
    open &&
    createPortal(
      <div
        ref={rootRef}
        role="menu"
        style={{
          position: 'fixed',
          top: menuPos.top,
          left: menuPos.left,
          zIndex: 10_000,
          width: 260,
          padding: space.sm,
          borderRadius: radius.md,
          border: `1px solid ${token('borderStrong')}`,
          background: token('surface'),
          boxShadow: elevation('menu'),
          display: 'flex',
          flexDirection: 'column',
          gap: space.sm,
        }}
      >
        {editable && !placeLocked && (
          <PlacePicker
            t={t}
            folders={wb.folders}
            folderId={task.folderId}
            isolated={task.isolated}
            onChange={(folderId, isolated) => void run(() => updateTask({ taskId: task.id, folderId, isolated }))}
          />
        )}
        {placeLocked && task.worktreeDisplay && (
          <p style={{ margin: 0, fontSize: fontSize.sm, color: token('textMuted') }}>
            {t('workbench.tasks.worktree')}{' '}
            <code style={{ fontSize: fontSize.xs }}>{task.worktreeDisplay}</code>
          </p>
        )}
        {editable && (
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onEdit();
            }}
            {...hoverBackground('transparent', token('surfaceHover'))}
            style={menuItemStyle}
          >
            {t('workbench.actions.editTask')}
          </button>
        )}
        {canRemove && (
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              if (task.worktreeDisplay) setConfirmRemove(true);
              else void run(() => removeTask(task.id));
            }}
            {...hoverBackground('transparent', token('surfaceHover'))}
            style={{ ...menuItemStyle, color: token('danger') }}
          >
            {t('workbench.actions.remove')}
          </button>
        )}
        {!editable && !canRemove && !placeLocked && (
          <p style={{ margin: 0, fontSize: fontSize.sm, color: token('textMuted') }}>{t('workbench.tasks.tabMenuEmpty')}</p>
        )}
      </div>,
      document.body,
    );

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={t('workbench.tasks.tabMenu')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggleMenu}
        onPointerDown={(e) => e.stopPropagation()}
        {...hoverBackground(rail ? token('surface') : token('surface'), token('surfaceHover'))}
        style={
          rail
            ? {
                all: 'unset',
                boxSizing: 'border-box',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 28,
                flexShrink: 0,
                alignSelf: 'stretch',
                borderLeft: `1px solid ${token('border')}`,
                background: token('surface'),
                color: token('textMuted'),
                fontSize: fontSize.xs,
              }
            : {
                all: 'unset',
                boxSizing: 'border-box',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 26,
                height: TASK_TAB_HEIGHT,
                marginTop: TASK_TAB_MARGIN_TOP,
                marginBottom: TASK_TAB_MARGIN_BOTTOM,
                borderRadius: `0 ${radius.sm}px 0 0`,
                border: `1px solid ${token('border')}`,
                borderLeft: 'none',
                borderBottom: `1px solid ${token('surface')}`,
                background: token('surface'),
                color: token('textMuted'),
                fontSize: fontSize.xs,
                flexShrink: 0,
              }
        }
      >
        ▾
      </button>
      {menu}
      {confirmRemove && (
        <ConfirmDialog
          title={t('workbench.removeConfirm')}
          message={task.branch ? `${t('workbench.tasks.branch')} ${task.branch}` : undefined}
          confirmLabel={t('workbench.removeConfirmYes')}
          cancelLabel={t('workbench.cancel')}
          danger
          onConfirm={() => {
            setConfirmRemove(false);
            void run(() => removeTask(task.id));
          }}
          onCancel={() => setConfirmRemove(false)}
        />
      )}
    </>
  );
}

const menuItemStyle: CSSProperties = {
  all: 'unset',
  boxSizing: 'border-box',
  cursor: 'pointer',
  width: '100%',
  textAlign: 'left',
  padding: '6px 8px',
  borderRadius: radius.sm,
  fontSize: fontSize.sm,
  color: token('text'),
};

function PlacePicker({
  t,
  folders,
  folderId,
  isolated,
  onChange,
}: {
  t: TranslateFn;
  folders: readonly FolderView[];
  folderId: string | null;
  isolated: boolean;
  onChange: (folderId: string | null, isolated: boolean) => void;
}) {
  const folder = folders.find((f) => f.id === folderId) ?? null;
  const canIsolate = folder?.isGitRepo === true;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space.xs }}>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: fontSize.sm }}>
        <span style={{ color: token('textMuted') }}>{t('workbench.tasks.folderLabel')}</span>
        <select
          value={folder?.id ?? ''}
          onChange={(e) => {
            const next = folders.find((f) => f.id === e.target.value) ?? null;
            onChange(next?.id ?? null, next?.isGitRepo ? isolated : false);
          }}
          style={{
            width: '100%',
            padding: '4px 8px',
            borderRadius: radius.sm,
            border: `1px solid ${token('borderStrong')}`,
            background: token('bg'),
            color: token('text'),
            fontSize: fontSize.sm,
          }}
        >
          <option value="">{t('workbench.tasks.noFolder')}</option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </label>
      <label
        title={canIsolate ? undefined : t('workbench.tasks.isolatedUnavailable')}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: space.sm,
          fontSize: fontSize.sm,
          color: canIsolate ? token('text') : token('textMuted'),
        }}
      >
        <input
          type="checkbox"
          checked={isolated && canIsolate}
          disabled={!canIsolate}
          onChange={(e) => onChange(folderId, e.target.checked)}
        />
        {t('workbench.tasks.isolated')}
      </label>
    </div>
  );
}
