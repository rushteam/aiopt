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
    checkForUpdates: '检查更新…',
    about: '关于',
    quit: '退出',
  },
};

/** Map an Electron `app.getLocale()` string to a supported menu locale. */
export function resolveMenuLocale(locale: string): MenuLocale {
  return locale.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}
