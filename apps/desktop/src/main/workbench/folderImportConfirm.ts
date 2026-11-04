// The native confirmation shown before files dropped from the OS file manager are copied into
// a granted folder. A drop is the one place the renderer hands main absolute paths, so a human
// confirms the exact list in a dialog the renderer cannot answer. Electron-free so the copy is
// unit-testable; services/registerHandlers show the dialog.

import { resolveMenuLocale, type MenuLocale } from '../menu/menuLabels';
import type { FolderImportConfirm } from './folderOps';

interface Labels {
  title: string;
  /** `{count}` and `{target}` are replaced. */
  message: string;
  confirm: string;
  cancel: string;
}

export const FOLDER_IMPORT_CONFIRM_LABELS: Record<MenuLocale, Labels> = {
  en: { title: 'Copy into folder', message: 'Copy {count} item(s) into “{target}”?', confirm: 'Copy', cancel: 'Cancel' },
  'zh-CN': { title: '复制到文件夹', message: '要把 {count} 项复制到「{target}」吗？', confirm: '复制', cancel: '取消' },
  ja: { title: 'フォルダーにコピー', message: '{count} 項目を「{target}」にコピーしますか？', confirm: 'コピー', cancel: 'キャンセル' },
  ko: { title: '폴더에 복사', message: '항목 {count}개를 “{target}”에 복사할까요?', confirm: '복사', cancel: '취소' },
  fr: { title: 'Copier dans le dossier', message: 'Copier {count} élément(s) dans « {target} » ?', confirm: 'Copier', cancel: 'Annuler' },
  de: { title: 'In Ordner kopieren', message: '{count} Element(e) nach „{target}“ kopieren?', confirm: 'Kopieren', cancel: 'Abbrechen' },
  es: { title: 'Copiar en la carpeta', message: '¿Copiar {count} elemento(s) en «{target}»?', confirm: 'Copiar', cancel: 'Cancelar' },
};

/** Paths listed in the dialog; the rest are summarized as `…`. */
const MAX_LISTED = 20;

export function buildFolderImportConfirm(
  locale: string,
  req: FolderImportConfirm,
): { title: string; message: string; detail: string; confirm: string; cancel: string } {
  const l = FOLDER_IMPORT_CONFIRM_LABELS[resolveMenuLocale(locale)];
  const target = req.relPath === '' ? req.folderName : `${req.folderName}/${req.relPath}`;
  const listed = req.paths.slice(0, MAX_LISTED);
  const more = req.paths.length - listed.length;
  return {
    title: l.title,
    message: l.message.replace('{count}', String(req.paths.length)).replace('{target}', target),
    detail: [...listed, ...(more > 0 ? [`… (+${more})`] : [])].join('\n'),
    confirm: l.confirm,
    cancel: l.cancel,
  };
}
