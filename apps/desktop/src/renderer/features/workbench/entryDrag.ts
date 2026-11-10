// The drag payload of an explorer entry: the folder's opaque id and a relative path, never an
// absolute path. The explorer moves / copies entries with it; a chat composer turns it into an
// `@folder/path` reference. A payload is in-app data, but it is still checked before use.

export const ENTRY_DRAG_TYPE = 'application/x-aiopt-workbench-entry';

export interface DraggedEntry {
  folderId: string;
  relPath: string;
}

/** Whether a drag carries an explorer entry (readable on dragover, before the drop). */
export function hasEntryDrag(dt: DataTransfer): boolean {
  return dt.types.includes(ENTRY_DRAG_TYPE);
}

/** The dropped entry, or null for a missing / malformed payload. */
export function readEntryDrag(dt: DataTransfer): DraggedEntry | null {
  return parseEntryDrag(dt.getData(ENTRY_DRAG_TYPE));
}

export function parseEntryDrag(raw: string): DraggedEntry | null {
  if (!raw || raw.length > 4096) return null;
  try {
    const doc = JSON.parse(raw) as { folderId?: unknown; relPath?: unknown };
    if (typeof doc.folderId !== 'string' || doc.folderId === '' || typeof doc.relPath !== 'string') return null;
    if (doc.relPath !== '' && doc.relPath.split('/').some((p) => p === '' || p === '.' || p === '..')) return null;
    return { folderId: doc.folderId, relPath: doc.relPath };
  } catch {
    return null;
  }
}
