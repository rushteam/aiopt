/** Persisted fraction of workbench width for the coordinator pane (0–1). */
export const WORKBENCH_SPLIT_STORAGE_KEY = 'workbench.chatPaneRatio';

export const WORKBENCH_SPLIT_DEFAULT = 0.42;
export const WORKBENCH_SPLIT_MIN = 0.22;
export const WORKBENCH_SPLIT_MAX = 0.68;

export const WORKBENCH_CHAT_MIN_PX = 220;
export const WORKBENCH_TASK_MIN_PX = 280;

export function clampWorkbenchSplitRatio(value: number): number {
  if (!Number.isFinite(value)) return WORKBENCH_SPLIT_DEFAULT;
  return Math.min(WORKBENCH_SPLIT_MAX, Math.max(WORKBENCH_SPLIT_MIN, value));
}

export function readWorkbenchSplitRatio(): number {
  try {
    const raw = localStorage.getItem(WORKBENCH_SPLIT_STORAGE_KEY);
    if (raw === null) return WORKBENCH_SPLIT_DEFAULT;
    return clampWorkbenchSplitRatio(Number(raw));
  } catch {
    return WORKBENCH_SPLIT_DEFAULT;
  }
}

export function writeWorkbenchSplitRatio(ratio: number): void {
  try {
    localStorage.setItem(WORKBENCH_SPLIT_STORAGE_KEY, String(clampWorkbenchSplitRatio(ratio)));
  } catch {
    // Preference only; ignore quota or private mode.
  }
}

/** Clamp ratio so both panes stay at least minPx wide inside totalWidth. */
export function clampSplitRatioToWidth(ratio: number, totalWidth: number): number {
  if (totalWidth <= 0) return clampWorkbenchSplitRatio(ratio);
  const minChat = WORKBENCH_CHAT_MIN_PX / totalWidth;
  const maxChat = 1 - WORKBENCH_TASK_MIN_PX / totalWidth;
  const lo = Math.max(WORKBENCH_SPLIT_MIN, minChat);
  const hi = Math.min(WORKBENCH_SPLIT_MAX, maxChat);
  if (lo > hi) return clampWorkbenchSplitRatio(ratio);
  return Math.min(hi, Math.max(lo, ratio));
}
