import {
  WORKBENCH_LIMITS,
  isLiveTaskStatus,
  taskDependenciesMet,
  type TaskView,
  type WorkbenchSnapshot,
} from '../../../shared/workbench';

export type ProposalBlocker = 'session' | 'folder' | 'dependencies' | 'limit';

/**
 * Why a proposed task can't run yet, or null when it can. Mirrors main's `canLaunch` for the
 * approval card's disabled states; main still re-checks every launch.
 */
export function proposalBlocker(
  task: Pick<TaskView, 'folderId' | 'dependsOn'>,
  wb: Pick<WorkbenchSnapshot, 'status' | 'herdrAvailable' | 'tasks' | 'folders'>,
): ProposalBlocker | null {
  if (wb.status !== 'ready' || !wb.herdrAvailable) return 'session';
  if (task.folderId === null || !wb.folders.some((f) => f.id === task.folderId)) return 'folder';
  if (!taskDependenciesMet(task, wb.tasks)) return 'dependencies';
  const live = wb.tasks.filter((x) => isLiveTaskStatus(x.status)).length;
  if (live >= WORKBENCH_LIMITS.liveTasks) return 'limit';
  return null;
}
