// Native application-menu labels, split into their own module so they are easy
// to audit against the product glossary (native menu strings are built in main
// and never pass through the renderer i18n JSON, so a dedicated test scans this
// table — see __tests__/menuLabels.test.ts). Keep every user-visible menu string
// here, one entry per supported locale.

/** Locales this menu is translated into. Mirror i18n/glossary.json `locales`. */
export type MenuLocale = 'en' | 'zh-CN';

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
};

/** Map an Electron `app.getLocale()` string to a supported menu locale. */
export function resolveMenuLocale(locale: string): MenuLocale {
  return locale.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
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
