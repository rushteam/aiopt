import { describe, expect, it } from 'vitest';
import { shouldShowUpdateNotice } from '../updateNoticeDismissal';

describe('updateNoticeDismissal', () => {
  it('shows the bar until that version is dismissed', () => {
    expect(shouldShowUpdateNotice('1.0.13', null)).toBe(true);
    expect(shouldShowUpdateNotice('1.0.13', '1.0.13')).toBe(false);
  });

  it('shows the bar again for a newer release', () => {
    expect(shouldShowUpdateNotice('1.0.14', '1.0.13')).toBe(true);
  });
});
