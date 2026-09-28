import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { elevation, fontSize, radius, space, token } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import type { TranslateFn } from '../../i18n';
import {
  pendingDependencies,
  taskAllows,
  taskDependenciesMet,
  type TaskView,
  type WorkbenchSnapshot,
} from '../../../shared/workbench';
import { completeTask, launchTask, runAllTasks, stopTask } from '../../lib/workbenchStore';
import { taskTabToolButtonStyle } from './taskTabChrome';

type Runner = (action: () => Promise<void>) => Promise<boolean>;

export function TaskBoardActionsMenu({
  wb,
  t,
  run,
  selectedTask,
  canRun,
  runnable,
  onEditTask,
  paired,
}: {
  wb: WorkbenchSnapshot;
  t: TranslateFn;
  run: Runner;
  selectedTask: TaskView | null;
  canRun: boolean;
  runnable: number;
  onEditTask: () => void;
  /** Renders flush with the new-task (+) control on the tab strip. */
  paired?: boolean;
}) {
  const [open, setOpen] = useState(false);
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

  const toggle = (e: MouseEvent): void => {
    e.stopPropagation();
    if (open) {
      setOpen(false);
      return;
    }
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) {
      const width = 220;
      setMenuPos({
        top: rect.bottom + 2,
        left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
      });
    }
    setOpen(true);
  };

  const folder = selectedTask ? (wb.folders.find((f) => f.id === selectedTask.folderId) ?? null) : null;
  const launchable =
    selectedTask &&
    taskAllows('launch', selectedTask.status) &&
    canRun &&
    folder !== null &&
    taskDependenciesMet(selectedTask, wb.tasks);

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
          width: 220,
          padding: space.xs,
          borderRadius: radius.md,
          border: `1px solid ${token('borderStrong')}`,
          background: token('surface'),
          boxShadow: elevation('menu'),
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <MenuItem
          disabled={!canRun || runnable === 0}
          onClick={() => {
            setOpen(false);
            void run(runAllTasks);
          }}
        >
          {t('workbench.tasks.runAll')}
          {runnable > 0 && <span style={{ marginLeft: space.xs, color: token('textMuted') }}>{runnable}</span>}
        </MenuItem>
        {selectedTask && taskAllows('launch', selectedTask.status) && (
          <MenuItem
            disabled={!launchable}
            onClick={() => {
              setOpen(false);
              void run(() => launchTask(selectedTask.id));
            }}
          >
            {selectedTask.status === 'proposed' ? t('workbench.actions.launch') : t('workbench.actions.relaunch')}
          </MenuItem>
        )}
        {selectedTask && taskAllows('stop', selectedTask.status) && (
          <MenuItem
            danger
            onClick={() => {
              setOpen(false);
              void run(() => stopTask(selectedTask.id));
            }}
          >
            {t('workbench.actions.stop')}
          </MenuItem>
        )}
        {selectedTask && taskAllows('complete', selectedTask.status) && (
          <MenuItem
            onClick={() => {
              setOpen(false);
              void run(() => completeTask(selectedTask.id));
            }}
          >
            {t('workbench.actions.complete')}
          </MenuItem>
        )}
        {selectedTask && taskAllows('edit', selectedTask.status) && (
          <MenuItem
            onClick={() => {
              setOpen(false);
              onEditTask();
            }}
          >
            {t('workbench.actions.editTask')}
          </MenuItem>
        )}
        {selectedTask?.failure && (
          <p style={{ margin: 0, padding: '6px 8px', fontSize: fontSize.xs, color: token('danger') }}>
            {t(`workbench.failure.${selectedTask.failure}`)}
          </p>
        )}
        {selectedTask && pendingDependencies(selectedTask, wb.tasks).length > 0 && (
          <p style={{ margin: 0, padding: '6px 8px', fontSize: fontSize.xs, color: token('textMuted') }}>
            {t('workbench.tasks.waitingOn')} {pendingDependencies(selectedTask, wb.tasks).map((d) => d.title).join(', ')}
          </p>
        )}
      </div>,
      document.body,
    );

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={t('workbench.tasks.boardMenu')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
        onPointerDown={(e) => e.stopPropagation()}
        {...hoverBackground(token('bg'), token('surfaceHover'))}
        style={taskTabToolButtonStyle(
          paired
            ? {
                borderRadius: `0 ${radius.sm}px 0 0`,
                fontSize: fontSize.md,
                letterSpacing: 1,
              }
            : { fontSize: fontSize.md, letterSpacing: 1 },
        )}
      >
        ⋯
      </button>
      {menu}
    </>
  );
}

function MenuItem({
  children,
  onClick,
  disabled,
  danger,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      {...hoverBackground('transparent', token('surfaceHover'))}
      style={{
        ...menuItemStyle,
        color: danger ? token('danger') : token('text'),
        opacity: disabled ? 0.45 : 1,
        cursor: disabled ? 'default' : 'pointer',
      }}
    >
      {children}
    </button>
  );
}

const menuItemStyle: CSSProperties = {
  all: 'unset',
  boxSizing: 'border-box',
  width: '100%',
  textAlign: 'left',
  padding: '6px 8px',
  borderRadius: radius.sm,
  fontSize: fontSize.sm,
};
