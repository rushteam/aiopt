// Map a thrown IPC error to a `skills.errors.*` i18n key.
//
// Import failures use stable `skill-import:*` tags from shared/skills (SKILL_IMPORT_FAIL).
// `invoke()` rejections may be a plain `{ message }` object — use ipcErrorFromUnknown.

import { ipcErrorFromUnknown } from '../../../shared/ipc-errors';
import { isSkillImportFailTag, SKILL_IMPORT_FAIL } from '../../../shared/skills';
import type { TranslateFn } from '../../i18n';

const IMPORT_FAIL_I18N: Record<(typeof SKILL_IMPORT_FAIL)[keyof typeof SKILL_IMPORT_FAIL], string> = {
  [SKILL_IMPORT_FAIL.missingMarker]: 'skills.errors.importMissingMarker',
  [SKILL_IMPORT_FAIL.parentFolder]: 'skills.errors.importParentFolder',
  [SKILL_IMPORT_FAIL.invalidFolderName]: 'skills.errors.importInvalidFolderName',
  [SKILL_IMPORT_FAIL.sourceNotDirectory]: 'skills.errors.importSourceNotDirectory',
  [SKILL_IMPORT_FAIL.sourceUnreachable]: 'skills.errors.importSourceUnreachable',
  [SKILL_IMPORT_FAIL.symlinkInTree]: 'skills.errors.importSymlinkInTree',
  [SKILL_IMPORT_FAIL.unsupportedFileType]: 'skills.errors.importUnsupportedFileType',
  [SKILL_IMPORT_FAIL.tooManyFiles]: 'skills.errors.importTooManyFiles',
  [SKILL_IMPORT_FAIL.tooLarge]: 'skills.errors.importTooLarge',
  [SKILL_IMPORT_FAIL.destinationFailed]: 'skills.errors.importDestinationFailed',
};

export function skillsErrorMessage(t: TranslateFn, err: unknown): string {
  const decoded = ipcErrorFromUnknown(err);

  if (isSkillImportFailTag(decoded.message)) {
    const key = IMPORT_FAIL_I18N[decoded.message];
    const translated = t(key);
    if (translated !== key) return translated;
  }

  // Legacy messages from older builds (before import fail tags).
  if (decoded.code === 'INVALID_PARAMS' && decoded.message.includes('not a skill')) {
    const key = 'skills.errors.importMissingMarker';
    const translated = t(key);
    if (translated !== key) return translated;
  }
  if (decoded.code === 'NOT_FOUND' && decoded.message.includes('import source')) {
    const key = 'skills.errors.importSourceUnreachable';
    const translated = t(key);
    if (translated !== key) return translated;
  }
  if (decoded.code === 'PERMISSION_DENIED' && decoded.message.includes('symbolic link')) {
    const key = 'skills.errors.importSymlinkInTree';
    const translated = t(key);
    if (translated !== key) return translated;
  }

  const key = `skills.errors.${decoded.code}`;
  const translated = t(key);
  return translated === key ? t('skills.errors.INTERNAL') : translated;
}
