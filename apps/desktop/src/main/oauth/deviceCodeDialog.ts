// The native dialog that shows a device-code sign-in's user code (GitHub Copilot). Main owns
// it so the code never crosses IPC; confirming copies the code to the clipboard and opens the
// vendor's device page. Electron-free so the copy is unit-testable; services shows it.

import { resolveMenuLocale, type MenuLocale } from '../menu/menuLabels';
import type { OAuthDeviceCodePrompt } from './drivers/types';

interface Labels {
  title: string;
  /** `{code}` is replaced. */
  message: string;
  /** `{host}` is replaced. */
  detail: string;
  confirm: string;
  cancel: string;
}

export const DEVICE_CODE_LABELS: Record<MenuLocale, Labels> = {
  en: {
    title: 'Sign in with GitHub',
    message: 'Your sign-in code: {code}',
    detail: 'The code is copied to your clipboard. Paste it on {host} to finish signing in.',
    confirm: 'Copy code and open browser',
    cancel: 'Cancel',
  },
  'zh-CN': {
    title: '用 GitHub 登录',
    message: '你的登录码：{code}',
    detail: '登录码会复制到剪贴板。在 {host} 页面粘贴即可完成登录。',
    confirm: '复制登录码并打开浏览器',
    cancel: '取消',
  },
  ja: {
    title: 'GitHub でログイン',
    message: 'ログインコード：{code}',
    detail: 'コードはクリップボードにコピーされます。{host} で貼り付けてログインを完了してください。',
    confirm: 'コードをコピーしてブラウザーを開く',
    cancel: 'キャンセル',
  },
  ko: {
    title: 'GitHub로 로그인',
    message: '로그인 코드: {code}',
    detail: '코드가 클립보드에 복사됩니다. {host}에 붙여넣어 로그인을 완료하세요.',
    confirm: '코드 복사 후 브라우저 열기',
    cancel: '취소',
  },
  fr: {
    title: 'Se connecter avec GitHub',
    message: 'Votre code de connexion : {code}',
    detail: 'Le code est copié dans le presse-papiers. Collez-le sur {host} pour terminer la connexion.',
    confirm: 'Copier le code et ouvrir le navigateur',
    cancel: 'Annuler',
  },
  de: {
    title: 'Mit GitHub anmelden',
    message: 'Ihr Anmeldecode: {code}',
    detail: 'Der Code wird in die Zwischenablage kopiert. Fügen Sie ihn auf {host} ein, um die Anmeldung abzuschließen.',
    confirm: 'Code kopieren und Browser öffnen',
    cancel: 'Abbrechen',
  },
  es: {
    title: 'Iniciar sesión con GitHub',
    message: 'Tu código de inicio de sesión: {code}',
    detail: 'El código se copia al portapapeles. Pégalo en {host} para terminar de iniciar sesión.',
    confirm: 'Copiar código y abrir el navegador',
    cancel: 'Cancelar',
  },
};

export function buildDeviceCodeDialog(
  locale: string,
  prompt: OAuthDeviceCodePrompt,
): { title: string; message: string; detail: string; confirm: string; cancel: string } {
  const l = DEVICE_CODE_LABELS[resolveMenuLocale(locale)];
  let host = prompt.verificationUri;
  try {
    host = new URL(prompt.verificationUri).host;
  } catch {
    // keep the raw value
  }
  return {
    title: l.title,
    message: l.message.replace('{code}', prompt.userCode),
    detail: l.detail.replace('{host}', host),
    confirm: l.confirm,
    cancel: l.cancel,
  };
}
