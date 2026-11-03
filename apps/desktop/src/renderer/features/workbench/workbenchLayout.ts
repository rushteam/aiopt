// Persisted Workbench layout: the left sidebar (vertical tabs + the plan's task tree) and the
// right explorer (granted folders as a file tree). Both collapse; widths are dragged. Only
// numbers and booleans are kept in localStorage — no paths, no task content.

export const SIDEBAR_WIDTH = { min: 180, max: 360, default: 224 } as const;
export const EXPLORER_WIDTH = { min: 200, max: 420, default: 260 } as const;
/** Width of a collapsed side (an icon rail). */
export const RAIL_WIDTH = 40;
/** Below this window width the sidebar starts collapsed (the user can still open it). */
export const NARROW_WINDOW = 900;

export interface WorkbenchLayout {
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  explorerWidth: number;
  /** Collapsed by default: the explorer is an aside, the conversation leads. */
  explorerCollapsed: boolean;
}

export const WORKBENCH_LAYOUT_STORAGE_KEY = 'workbench.layout.v1';

export const DEFAULT_WORKBENCH_LAYOUT: WorkbenchLayout = {
  sidebarWidth: SIDEBAR_WIDTH.default,
  sidebarCollapsed: false,
  explorerWidth: EXPLORER_WIDTH.default,
  explorerCollapsed: true,
};

export function clampWidth(value: unknown, bounds: { min: number; max: number; default: number }): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return bounds.default;
  return Math.round(Math.min(bounds.max, Math.max(bounds.min, value)));
}

/** Parse a stored layout; anything missing or malformed falls back to the default. */
export function parseWorkbenchLayout(raw: string | null): WorkbenchLayout {
  if (!raw) return DEFAULT_WORKBENCH_LAYOUT;
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return DEFAULT_WORKBENCH_LAYOUT;
  }
  if (!doc || typeof doc !== 'object') return DEFAULT_WORKBENCH_LAYOUT;
  const d = doc as Record<string, unknown>;
  const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
  return {
    sidebarWidth: clampWidth(d.sidebarWidth, SIDEBAR_WIDTH),
    sidebarCollapsed: bool(d.sidebarCollapsed, DEFAULT_WORKBENCH_LAYOUT.sidebarCollapsed),
    explorerWidth: clampWidth(d.explorerWidth, EXPLORER_WIDTH),
    explorerCollapsed: bool(d.explorerCollapsed, DEFAULT_WORKBENCH_LAYOUT.explorerCollapsed),
  };
}

export function readWorkbenchLayout(): WorkbenchLayout {
  try {
    return parseWorkbenchLayout(window.localStorage.getItem(WORKBENCH_LAYOUT_STORAGE_KEY));
  } catch {
    return DEFAULT_WORKBENCH_LAYOUT;
  }
}

export function writeWorkbenchLayout(layout: WorkbenchLayout): void {
  try {
    window.localStorage.setItem(WORKBENCH_LAYOUT_STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // Storage full or blocked: the layout just isn't remembered.
  }
}
