// Which files exist, for linking plain paths in chat (see `findPathRefs`). A plain path only
// becomes a link once the listing of its directory shows the file — through the same read-only,
// folder-confined listing the explorer uses, so nothing new crosses the IPC boundary.

import { useCallback, useMemo, useRef, useState } from 'react';
import { listFolder } from '../../lib/workbenchStore';
import type { FileRefTarget } from './fileRefs';

/** A listing older than this is fetched again (an agent may have created the file since). */
export const PROBE_TTL_MS = 15_000;
/** Directory listings in flight at once. */
const PROBE_PARALLEL = 4;

interface DirFiles {
  at: number;
  files: ReadonlySet<string> | null; // null: still loading
}

function splitPath(relPath: string): { dir: string; name: string } {
  const at = relPath.lastIndexOf('/');
  return at < 0 ? { dir: '', name: relPath } : { dir: relPath.slice(0, at), name: relPath.slice(at + 1) };
}

const dirKey = (folderId: string, dir: string): string => `${folderId}\u0000${dir}`;

export interface FileProbe {
  /** True / false when known, undefined while unknown. */
  fileExists: (target: FileRefTarget) => boolean | undefined;
  /** Load the listings `targets` need (cached, refreshed after `PROBE_TTL_MS`). */
  probe: (targets: readonly FileRefTarget[]) => void;
  /** Changes whenever a listing lands, so consumers re-render. */
  version: number;
}

export function useFileProbe(): FileProbe {
  const cache = useRef(new Map<string, DirFiles>());
  const queue = useRef<{ folderId: string; dir: string }[]>([]);
  const running = useRef(0);
  const [version, setVersion] = useState(0);

  const pump = useCallback((): void => {
    while (running.current < PROBE_PARALLEL && queue.current.length > 0) {
      const { folderId, dir } = queue.current.shift()!;
      const key = dirKey(folderId, dir);
      running.current += 1;
      listFolder(folderId, dir)
        .then(
          (listing) => new Set(listing.entries.filter((e) => e.kind === 'file').map((e) => e.name)),
          () => new Set<string>(),
        )
        .then((files) => {
          cache.current.set(key, { at: Date.now(), files });
          running.current -= 1;
          setVersion((v) => v + 1);
          pump();
        });
    }
  }, []);

  const probe = useCallback(
    (targets: readonly FileRefTarget[]): void => {
      const now = Date.now();
      for (const t of targets) {
        const { dir } = splitPath(t.relPath);
        const key = dirKey(t.folderId, dir);
        const hit = cache.current.get(key);
        if (hit && (hit.files === null || now - hit.at < PROBE_TTL_MS)) continue;
        cache.current.set(key, { at: now, files: null });
        queue.current.push({ folderId: t.folderId, dir });
      }
      pump();
    },
    [pump],
  );

  const fileExists = useCallback(
    (t: FileRefTarget): boolean | undefined => {
      const { dir, name } = splitPath(t.relPath);
      const files = cache.current.get(dirKey(t.folderId, dir))?.files;
      return files ? files.has(name) : undefined;
    },
    // `version` re-creates this so memoized consumers see new listings.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version],
  );

  return useMemo(() => ({ fileExists, probe, version }), [fileExists, probe, version]);
}
