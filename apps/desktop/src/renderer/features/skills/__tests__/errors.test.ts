import { describe, expect, it } from 'vitest';
import { encodeIpcError } from '../../../../shared/ipc-errors';
import { SKILL_IMPORT_FAIL } from '../../../../shared/skills';
import { makeTranslate } from '../../../i18n';
import { skillsErrorMessage } from '../errors';

describe('skillsErrorMessage', () => {
  const t = makeTranslate('en');

  it('maps import fail tags from a plain Electron rejection object', () => {
    const wire = encodeIpcError('INVALID_PARAMS', SKILL_IMPORT_FAIL.parentFolder);
    const msg = skillsErrorMessage(t, { message: wire });
    expect(msg).toContain('parent folder');
    expect(msg).not.toBe(t('skills.errors.INTERNAL'));
  });

  it('maps import fail tags from an Error', () => {
    const wire = encodeIpcError('INVALID_PARAMS', SKILL_IMPORT_FAIL.missingMarker);
    const msg = skillsErrorMessage(t, new Error(wire));
    expect(msg).toContain('SKILL.md');
  });
});
