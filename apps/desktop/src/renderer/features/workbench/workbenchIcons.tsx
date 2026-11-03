// Line glyphs for the Workbench sidebar and explorer. Stroke follows currentColor so they read
// in both themes (same convention as components/ui/EyeIcon).

import type { ReactNode } from 'react';

function Glyph({ size = 16, children }: { size?: number; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{ flexShrink: 0, display: 'block' }}
    >
      {children}
    </svg>
  );
}

export function ChatIcon({ size }: { size?: number }) {
  return (
    <Glyph size={size}>
      <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z" />
    </Glyph>
  );
}

/** A small graph: the plan's task DAG. */
export function PlanIcon({ size }: { size?: number }) {
  return (
    <Glyph size={size}>
      <rect x="3" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="16" width="7" height="5" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
      <path d="M6.5 8v8M6.5 12h11v4" />
    </Glyph>
  );
}

/** A window with one side panel; `side` picks which (sidebar = left, explorer = right). */
export function PanelIcon({ side, size }: { side: 'left' | 'right'; size?: number }) {
  return (
    <Glyph size={size}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      {side === 'left' ? <path d="M9 4v16" /> : <path d="M15 4v16" />}
    </Glyph>
  );
}

export function FolderIcon({ size, open = false }: { size?: number; open?: boolean }) {
  return (
    <Glyph size={size}>
      {open ? (
        <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h7.5A1.5 1.5 0 0 1 20 9.5V10H7.2a1.5 1.5 0 0 0-1.4 1L3.5 18M3 7.5V18h15.3a1.5 1.5 0 0 0 1.4-1l1.8-5.7A1 1 0 0 0 20.5 10" />
      ) : (
        <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5Z" />
      )}
    </Glyph>
  );
}

export function FileIcon({ size }: { size?: number }) {
  return (
    <Glyph size={size}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5" />
    </Glyph>
  );
}

export function ChevronIcon({ open, size = 12 }: { open: boolean; size?: number }) {
  return (
    <Glyph size={size}>
      <path d={open ? 'm6 9 6 6 6-6' : 'm9 6 6 6-6 6'} />
    </Glyph>
  );
}

export function PlusIcon({ size }: { size?: number }) {
  return (
    <Glyph size={size}>
      <path d="M12 5v14M5 12h14" />
    </Glyph>
  );
}

export function RefreshIcon({ size }: { size?: number }) {
  return (
    <Glyph size={size}>
      <path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" />
    </Glyph>
  );
}

export function CloseIcon({ size = 12 }: { size?: number }) {
  return (
    <Glyph size={size}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Glyph>
  );
}
