import { describe, expect, it } from 'vitest';
import { changeTotals, diffRows } from '../diffView';

describe('diffRows', () => {
  it('drops the file header and numbers lines per hunk', () => {
    const patch = [
      'diff --git a/a.ts b/a.ts',
      'index 1..2 100644',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -3,3 +3,3 @@ fn',
      ' keep',
      '-old',
      '+new',
      '\\ No newline at end of file',
      '',
    ].join('\n');
    expect(diffRows(patch)).toEqual([
      { kind: 'hunk', text: '@@ -3,3 +3,3 @@ fn', oldNo: null, newNo: null },
      { kind: 'ctx', text: 'keep', oldNo: 3, newNo: 3 },
      { kind: 'del', text: 'old', oldNo: 4, newNo: null },
      { kind: 'add', text: 'new', oldNo: null, newNo: 4 },
      { kind: 'note', text: 'No newline at end of file', oldNo: null, newNo: null },
    ]);
  });

  it('shows nothing for a patch without hunks (binary, mode change)', () => {
    expect(diffRows('diff --git a/x b/x\nBinary files a/x and b/x differ\n')).toEqual([]);
  });

  it('adds up counts, skipping binaries', () => {
    expect(
      changeTotals([
        { additions: 2, deletions: 1 },
        { additions: null, deletions: null },
        { additions: 3, deletions: 0 },
      ]),
    ).toEqual({ additions: 5, deletions: 1 });
  });
});
