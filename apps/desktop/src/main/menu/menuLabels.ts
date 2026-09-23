// Native application-menu labels, split into their own module so they are easy
// to audit against the product glossary (native menu strings are built in main
// and never pass through the renderer i18n JSON, so a dedicated test scans this
// table — see __tests__/menuLabels.test.ts). Keep every user-visible menu string
// here, one entry per supported locale.

/**
 * Locales this menu is translated into. Mirrors i18n/glossary.json `locales`, which is
 * in turn the set the renderer ships — a user who can pick 日本語 in Settings should not
 * get an English menu bar for it.
 */
export type MenuLocale = 'en' | 'zh-CN' | 'ja' | 'ko' | 'fr' | 'de' | 'es';

export interface MenuLabels {
  /** Top-level submenu titles. */
  file: string;
  edit: string;
  view: string;
  window: string;
  help: string;
  /** Command items that dispatch to the renderer. */
  settings: string;
  /** Tray item that reveals/focuses the main window (main-side, no renderer command). */
  showWindow: string;
  usage: string;
  skills: string;
  checkForUpdates: string;
  about: string;
  /** Native role items whose label we localize. */
  quit: string;
}

export const MENU_LABELS: Record<MenuLocale, MenuLabels> = {
  en: {
    file: 'File',
    edit: 'Edit',
    view: 'View',
    window: 'Window',
    help: 'Help',
    settings: 'Settings…',
    showWindow: 'Show AiOpt',
    usage: 'Usage',
    skills: 'Skills',
    checkForUpdates: 'Check for Updates…',
    about: 'About',
    quit: 'Quit',
  },
  'zh-CN': {
    file: '文件',
    edit: '编辑',
    view: '视图',
    window: '窗口',
    help: '帮助',
    settings: '设置…',
    showWindow: '显示主界面',
    usage: '统计',
    skills: '技能',
    checkForUpdates: '检查更新…',
    about: '关于',
    quit: '退出',
  },
  ja: {
    file: 'ファイル',
    edit: '編集',
    view: '表示',
    window: 'ウインドウ',
    help: 'ヘルプ',
    settings: '設定…',
    showWindow: 'AiOpt を表示',
    usage: '使用状況',
    skills: 'スキル',
    checkForUpdates: '更新を確認…',
    about: 'このアプリについて',
    quit: '終了',
  },
  ko: {
    file: '파일',
    edit: '편집',
    view: '보기',
    window: '윈도우',
    help: '도움말',
    settings: '설정…',
    showWindow: 'AiOpt 표시',
    usage: '사용량',
    skills: '스킬',
    checkForUpdates: '업데이트 확인…',
    about: '정보',
    quit: '종료',
  },
  fr: {
    file: 'Fichier',
    edit: 'Édition',
    view: 'Présentation',
    window: 'Fenêtre',
    help: 'Aide',
    settings: 'Réglages…',
    showWindow: 'Afficher AiOpt',
    usage: 'Utilisation',
    skills: 'Compétences',
    checkForUpdates: 'Rechercher des mises à jour…',
    about: 'À propos',
    quit: 'Quitter',
  },
  de: {
    file: 'Datei',
    edit: 'Bearbeiten',
    view: 'Darstellung',
    window: 'Fenster',
    help: 'Hilfe',
    settings: 'Einstellungen…',
    showWindow: 'AiOpt anzeigen',
    usage: 'Nutzung',
    skills: 'Skills',
    checkForUpdates: 'Nach Updates suchen…',
    about: 'Über',
    quit: 'Beenden',
  },
  es: {
    file: 'Archivo',
    edit: 'Edición',
    view: 'Visualización',
    window: 'Ventana',
    help: 'Ayuda',
    settings: 'Ajustes…',
    showWindow: 'Mostrar AiOpt',
    usage: 'Uso',
    skills: 'Habilidades',
    checkForUpdates: 'Buscar actualizaciones…',
    about: 'Acerca de',
    quit: 'Salir',
  },
};

// Prefix → locale, first match wins. Deliberately the same entries in the same order as
// the renderer's LOCALE_BY_PREFIX (renderer/i18n/index.tsx), because the menu bar and the
// window beneath it must not disagree about what a locale string means; keep the two in
// step when either gains a locale.
//
// Every prefix is a bare language subtag, so `zh-Hant` resolves to zh-CN — we ship only
// Simplified, and a Traditional user is better served by Chinese menus than by English
// ones. Add a `zh-Hant` entry BEFORE `zh` if that locale is ever added.
const MENU_LOCALE_BY_PREFIX: ReadonlyArray<readonly [string, MenuLocale]> = [
  ['zh', 'zh-CN'],
  ['ja', 'ja'],
  ['ko', 'ko'],
  ['fr', 'fr'],
  ['de', 'de'],
  ['es', 'es'],
  ['en', 'en'],
];

/**
 * Map an Electron `app.getLocale()` string (or a stored preference) to a supported menu
 * locale, matching on the language subtag so `de-AT` lands on `de`. Anything unmatched
 * falls back to `en` — the source locale, and the only safe default for an unknown tag.
 */
export function resolveMenuLocale(locale: string): MenuLocale {
  const lower = locale.toLowerCase();
  for (const [prefix, menuLocale] of MENU_LOCALE_BY_PREFIX) {
    if (lower.startsWith(prefix)) return menuLocale;
  }
  return 'en';
}

/**
 * The menu locale for a user's stored language PREFERENCE, falling back to the OS
 * locale only when the preference is `system`.
 *
 * Native menu builders must use this and not `resolveMenuLocale(app.getLocale())`:
 * the OS locale is the default, not the answer. A user whose Mac is in English but
 * who picked 中文 in Settings was getting a Chinese app window with an English menu
 * bar and tray, because the preference never reached the menu builders at all.
 *
 * Pure (both inputs injected) so the rule is unit-tested without Electron; this is
 * the same shape as the quit dialog's resolution in index.ts.
 */
export function resolveMenuLocaleForPreference(
  languagePreference: string,
  osLocale: string,
): MenuLocale {
  return resolveMenuLocale(languagePreference === 'system' ? osLocale : languagePreference);
}
