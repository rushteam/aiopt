// The plan of the conversation the coordinator is in: its tasks as a DAG, progress, "run the
// whole plan", and the new-task form. Each conversation owns its own plan. Clicking a node
// opens that task (its own sidebar tab); tasks of other conversations live in the sidebar.
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
import type { TaskSeed } from './taskSeed';
import { TaskDagView } from './TaskDagView';

type Runner = (action: () => Promise<void>) => Promise<boolean>;

export function PlanPanel({
  wb,
  t,
  run,
  selectedId,
  onSelectTask,
  seed = null,
  onSeedUsed,
}: {
  wb: WorkbenchSnapshot;
  t: TranslateFn;
  run: Runner;
  selectedId: string | null;
  onSelectTask: (id: string) => void;
  /** A draft handed over from Sessions: opens the new-task form with it. */
  seed?: TaskSeed | null;
  onSeedUsed?: () => void;
}) {
  const conversationId = wb.currentConversationId;
  const plan = useMemo(() => planTasksOf(wb.tasks, conversationId), [wb.tasks, conversationId]);
  const waitingIds = useMemo(() => new Set(wb.pendingWrites.map((r) => r.taskId)), [wb.pendingWrites]);
  const progress = planProgress(plan);
  const [creating, setCreating] = useState(false);
  const [draftSeed, setDraftSeed] = useState<TaskSeed | null>(null);
  const [seedCount, setSeedCount] = useState(0);
  useEffect(() => {
    if (!seed) return;
    setDraftSeed(seed);
    setSeedCount((n) => n + 1);
    setCreating(true);
    onSeedUsed?.();
  }, [seed, onSeedUsed]);
  const closeForm = () => {
    setCreating(false);
    setDraftSeed(null);
  };
  const boardFull = wb.tasks.length >= WORKBENCH_LIMITS.tasks;

  const canRunPlan = conversationId !== null && progress.awaitingApproval > 0 && wb.status === 'ready';

  return (
    <section
      aria-label={t('workbench.plan.title')}
      style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
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
          title={wb.status === 'ready' ? t('workbench.plan.runHint') : t('workbench.notRunningHint')}
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
            // A new seed while the form is open restarts it with that draft.
            key={seedCount}
            t={t}
            folders={wb.folders}
            submitLabel={t('workbench.tasks.create')}
            initial={{
              title: draftSeed?.title ?? '',
              prompt: draftSeed?.prompt ?? '',
              folderId: wb.folders.length === 1 ? (wb.folders[0]?.id ?? null) : null,
              isolated: false,
            }}
            onCancel={closeForm}
            onSubmit={async (draft) => {
              // A task added here joins the current conversation's plan (main files it there).
              if (await run(() => createTask(draft))) closeForm();
            }}
          />
        </div>
      )}

      {plan.length === 0 ? (
        <p style={{ margin: 0, padding: space.lg, fontSize: fontSize.base, color: token('textMuted') }}>
          {t('workbench.plan.empty')}
        </p>
      ) : (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'auto' }}>
          <TaskDagView
            tasks={plan}
            selectedId={selectedId}
            onSelect={onSelectTask}
            t={t}
            maxHeight={null}
            waitingIds={waitingIds}
          />
          <p style={{ margin: 0, padding: `0 ${space.lg}px ${space.lg}px`, fontSize: fontSize.sm, color: token('textMuted') }}>
            {t('workbench.plan.pickNode')}
          </p>
        </div>
      )}
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
