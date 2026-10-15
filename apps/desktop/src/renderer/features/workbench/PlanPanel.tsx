// The plan of the conversation the coordinator is in: its tasks as a DAG, progress, "run the
// whole plan", and the selected node's detail. Each conversation owns its own plan; tasks from
// other conversations (or from before plans existed) are listed below so they stay reachable.
//
// "Run plan" approves every waiting task of this plan in one call; main then starts each one as
// its dependencies finish. The coordinator drives it from there (review → done) and gives the
// final verdict when everything is done.

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { disabledOpacity, fontSize, radius, space, token } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import type { TranslateFn } from '../../i18n';
import { createTask, runPlan } from '../../lib/workbenchStore';
import { WORKBENCH_LIMITS, planProgress, planTasksOf, type WorkbenchSnapshot } from '../../../shared/workbench';
import { TaskForm } from './TaskForm';
import { TaskDagView } from './TaskDagView';
import { TaskNodeDetail } from './TaskNodeDetail';
import { StatusLabel } from './TaskStatusLabel';

type Runner = (action: () => Promise<void>) => Promise<boolean>;

export function PlanPanel({
  wb,
  t,
  run,
  selectedId,
  onSelectTask,
}: {
  wb: WorkbenchSnapshot;
  t: TranslateFn;
  run: Runner;
  selectedId: string | null;
  onSelectTask: (id: string | null) => void;
}) {
  const conversationId = wb.currentConversationId;
  const plan = useMemo(() => planTasksOf(wb.tasks, conversationId), [wb.tasks, conversationId]);
  const others = useMemo(
    () => wb.tasks.filter((x) => x.conversationId !== conversationId || conversationId === null),
    [wb.tasks, conversationId],
  );
  const progress = planProgress(plan);
  const selected = wb.tasks.find((x) => x.id === selectedId) ?? null;
  const [showOthers, setShowOthers] = useState(false);
  const [creating, setCreating] = useState(false);
  const boardFull = wb.tasks.length >= WORKBENCH_LIMITS.tasks;

  // Keep a node selected while the plan has any; drop a selection that left the board.
  useEffect(() => {
    if (selectedId !== null && !wb.tasks.some((x) => x.id === selectedId)) onSelectTask(null);
    else if (selectedId === null && plan.length > 0) onSelectTask(plan[0]!.id);
  }, [selectedId, wb.tasks, plan, onSelectTask]);

  const canRunPlan = conversationId !== null && progress.awaitingApproval > 0 && wb.status === 'ready';

  return (
    <section
      aria-label={t('workbench.plan.title')}
      style={{ ...panelStyle, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
    >
      <div style={toolbarStyle}>
        <h2 style={{ margin: 0, fontSize: fontSize.lg, fontWeight: 600 }}>{t('workbench.plan.title')}</h2>
        {progress.total > 0 && (
          <span style={{ fontSize: fontSize.sm, color: token('textMuted'), fontVariantNumeric: 'tabular-nums' }}>
            {t('workbench.plan.progress')
              .replace('{{done}}', String(progress.done))
              .replace('{{total}}', String(progress.total))}
          </span>
        )}
        {progress.state !== 'empty' && (
          <span style={stateChipStyle(progress.state)}>{t(`workbench.plan.state.${progress.state}`)}</span>
        )}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          disabled={boardFull || creating}
          onClick={() => setCreating(true)}
          {...hoverBackground('transparent', token('surfaceHover'))}
          style={{ ...ghostButtonStyle, opacity: boardFull || creating ? disabledOpacity : 1 }}
        >
          {t('workbench.tasks.new')}
        </button>
        <button
          type="button"
          disabled={!canRunPlan}
          onClick={() => conversationId && void run(() => runPlan(conversationId))}
          title={t('workbench.plan.runHint')}
          {...(canRunPlan ? hoverBackground(token('accent'), token('accentHover')) : {})}
          style={{ ...accentButtonStyle, opacity: canRunPlan ? 1 : disabledOpacity }}
        >
          {t('workbench.plan.run')}
          {progress.awaitingApproval > 0 && (
            <span style={{ marginLeft: space.xs, fontVariantNumeric: 'tabular-nums' }}>{progress.awaitingApproval}</span>
          )}
        </button>
      </div>

      {creating && (
        <div style={{ padding: space.md, borderBottom: `1px solid ${token('border')}`, flexShrink: 0, overflowY: 'auto', maxHeight: '50%' }}>
          <TaskForm
            t={t}
            folders={wb.folders}
            submitLabel={t('workbench.tasks.create')}
            initial={{ title: '', prompt: '', folderId: wb.folders.length === 1 ? (wb.folders[0]?.id ?? null) : null, isolated: false }}
            onCancel={() => setCreating(false)}
            onSubmit={async (draft) => {
              // A task added here joins the current conversation's plan (main files it there).
              if (await run(() => createTask(draft))) setCreating(false);
            }}
          />
        </div>
      )}

      {plan.length === 0 ? (
        <p style={{ margin: 0, padding: space.lg, fontSize: fontSize.base, color: token('textMuted') }}>
          {t('workbench.plan.empty')}
        </p>
      ) : (
        <div style={{ flexShrink: 0, borderBottom: `1px solid ${token('border')}`, maxHeight: '40%', display: 'flex' }}>
          <TaskDagView
            tasks={plan}
            selectedId={selectedId}
            onSelect={onSelectTask}
            t={t}
            maxHeight={null}
          />
        </div>
      )}

      {others.length > 0 && (
        <div style={{ flexShrink: 0, borderBottom: `1px solid ${token('border')}` }}>
          <button
            type="button"
            aria-expanded={showOthers}
            onClick={() => setShowOthers((v) => !v)}
            {...hoverBackground('transparent', token('surfaceHover'))}
            style={othersToggleStyle}
          >
            {showOthers ? '▾' : '▸'} {t('workbench.plan.others')}
            <span style={{ marginLeft: space.xs, color: token('textMuted'), fontVariantNumeric: 'tabular-nums' }}>
              {others.length}
            </span>
          </button>
          {showOthers && (
            <ul style={othersListStyle}>
              {others.map((task) => (
                <li key={task.id}>
                  <button
                    type="button"
                    aria-pressed={task.id === selectedId}
                    onClick={() => onSelectTask(task.id)}
                    {...hoverBackground(task.id === selectedId ? token('surfaceHover') : 'transparent', token('surfaceHover'))}
                    style={{ ...otherRowStyle, background: task.id === selectedId ? token('surfaceHover') : 'transparent' }}
                  >
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {task.title}
                    </span>
                    <StatusLabel status={task.status} approved={task.approved} t={t} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {selected ? (
          <TaskNodeDetail
            key={selected.id}
            task={selected}
            planTasks={selected.conversationId === conversationId ? plan : others}
            wb={wb}
            t={t}
            run={run}
          />
        ) : (
          plan.length > 0 && (
            <p style={{ margin: 0, padding: space.lg, fontSize: fontSize.base, color: token('textMuted') }}>
              {t('workbench.plan.pickNode')}
            </p>
          )
        )}
      </div>
    </section>
  );
}

function stateChipStyle(state: string): CSSProperties {
  const color =
    state === 'complete' ? token('success') : state === 'running' ? token('accent') : state === 'stalled' ? token('danger') : token('textMuted');
  return {
    fontSize: fontSize.xs,
    fontWeight: 600,
    color,
    border: `1px solid ${token('border')}`,
    borderRadius: radius.pill,
    padding: '1px 8px',
    whiteSpace: 'nowrap',
  };
}

const panelStyle: CSSProperties = {
  border: `1px solid ${token('border')}`,
  borderRadius: radius.lg,
  background: token('bg'),
};

const toolbarStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: space.md,
  padding: '8px 12px',
  borderBottom: `1px solid ${token('border')}`,
  flexShrink: 0,
  flexWrap: 'wrap',
};

const accentButtonStyle: CSSProperties = {
  padding: '4px 12px',
  borderRadius: radius.sm,
  border: `1px solid ${token('accent')}`,
  background: token('accent'),
  color: token('accentText'),
  cursor: 'pointer',
  fontSize: fontSize.sm,
  fontWeight: 600,
  whiteSpace: 'nowrap',
};

const ghostButtonStyle: CSSProperties = {
  padding: '4px 12px',
  borderRadius: radius.sm,
  border: `1px solid ${token('borderStrong')}`,
  background: 'transparent',
  color: token('text'),
  cursor: 'pointer',
  fontSize: fontSize.sm,
  whiteSpace: 'nowrap',
};

const othersToggleStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  width: '100%',
  padding: '6px 12px',
  border: 'none',
  background: 'transparent',
  color: token('text'),
  cursor: 'pointer',
  fontSize: fontSize.sm,
  textAlign: 'left',
};

const othersListStyle: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: `0 ${space.sm}px ${space.sm}px`,
  maxHeight: 160,
  overflowY: 'auto',
};

const otherRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: space.md,
  width: '100%',
  boxSizing: 'border-box',
  padding: '4px 8px',
  border: 'none',
  borderRadius: radius.sm,
  color: token('text'),
  cursor: 'pointer',
  fontSize: fontSize.base,
  textAlign: 'left',
};
