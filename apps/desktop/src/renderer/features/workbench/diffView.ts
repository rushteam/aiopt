// A unified diff of one file, as rows the changes view shows: hunk headers, then context,
// added and removed lines with their old / new line numbers. The `diff --git` / `index` /
// `---` / `+++` header before the first hunk is dropped (the row above already names the file).

export type DiffRowKind = 'hunk' | 'add' | 'del' | 'ctx' | 'note';

export interface DiffRow {
  kind: DiffRowKind;
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function diffRows(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  const lines = patch.split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const line of lines) {
    const hunk = HUNK_RE.exec(line);
    if (hunk) {
      inHunk = true;
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      rows.push({ kind: 'hunk', text: line, oldNo: null, newNo: null });
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+')) rows.push({ kind: 'add', text: line.slice(1), oldNo: null, newNo: newNo++ });
    else if (line.startsWith('-')) rows.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++, newNo: null });
    else if (line.startsWith('\\')) rows.push({ kind: 'note', text: line.slice(1).trim(), oldNo: null, newNo: null });
    else if (line.startsWith('diff --git ')) inHunk = false;
    else rows.push({ kind: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
  }
  return rows;
}

/** Totals over the files that report counts (binary files report none). */
export function changeTotals(files: readonly { additions: number | null; deletions: number | null }[]): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const f of files) {
    additions += f.additions ?? 0;
    deletions += f.deletions ?? 0;
  }
  return { additions, deletions };
}
