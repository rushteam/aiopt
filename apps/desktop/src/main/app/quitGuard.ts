// Quit guard — warn before a REAL quit while proxied agent bindings are live.
//
// A proxied binding writes the loopback proxy address (127.0.0.1:<port>) into the
// agent's own config; the real key stays main-side (see providerManager.applyBinding
// + the proxyMode note in ipc-channels.ts). A genuine quit stops that listener, so
// every proxied agent can't connect until AiOpt runs again — at which point the
// persisted port+tokens self-heal the routes (proxyStore.ts). So the cost is bounded
// to "while AiOpt is not running", but it is real and invisible, so we surface it.
//
// This module is Electron-free so the decision + copy are unit-testable. The actual
// dialog + lifecycle wiring live in the before-quit handler (index.ts), which injects
// the count, the preference, and a confirm function. We NEVER rewrite a config or
// write a key here — the guard only informs; the user decides.

/** Locales the quit dialog is translated into. Mirrors menuLabels.MenuLocale. */
export type QuitDialogLocale = 'en' | 'zh-CN';

export interface QuitDialogLabels {
  title: string;
  /** `{count}` is replaced with the number of live proxied agents. */
  message: string;
  detail: string;
  confirm: string;
  cancel: string;
  dontAskAgain: string;
}

export const QUIT_DIALOG_LABELS: Record<QuitDialogLocale, QuitDialogLabels> = {
  en: {
    title: 'Quit AiOpt?',
    message: '{count} agent(s) are routed through the AiOpt proxy.',
    detail:
      'While AiOpt is not running they cannot connect. They reconnect automatically the next time you open AiOpt.',
    confirm: 'Quit anyway',
    cancel: 'Cancel',
    dontAskAgain: "Don't ask again",
  },
  'zh-CN': {
    title: '退出 AiOpt？',
    message: '有 {count} 个 agent 正通过 AiOpt 代理连接。',
    detail: '在 AiOpt 未运行期间它们将无法连接；下次打开 AiOpt 时会自动恢复。',
    confirm: '仍然退出',
    cancel: '取消',
    dontAskAgain: '不再提醒',
  },
};

/** Map an Electron/config locale string to a supported dialog locale. */
export function resolveQuitDialogLocale(locale: string): QuitDialogLocale {
  return locale.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

/** Fill the `{count}` placeholder in the message line. */
export function formatQuitMessage(labels: QuitDialogLabels, count: number): string {
  return labels.message.replace('{count}', String(count));
}

/**
 * The one decision: should the quit path show the warning? True only when the user
 * hasn't opted out AND at least one binding is currently proxied. Pure so the
 * before-quit handler stays a thin shell over a tested rule.
 */
export function shouldWarnBeforeQuit(warnEnabled: boolean, proxiedCount: number): boolean {
  return warnEnabled && proxiedCount > 0;
}
