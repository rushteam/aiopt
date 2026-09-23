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

import { resolveMenuLocale, type MenuLocale } from '../menu/menuLabels';

/**
 * Locales the quit dialog is translated into. Mirrors menuLabels.MenuLocale — this is a
 * native dialog, so like the menu bar it can't reach the renderer's i18n JSON and carries
 * its own copy.
 */
export type QuitDialogLocale = MenuLocale;

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
  ja: {
    title: 'AiOpt を終了しますか？',
    message: '{count} 個のエージェントが AiOpt のプロキシ経由で接続しています。',
    detail:
      'AiOpt が実行されていない間、これらは接続できません。次に AiOpt を開いたときに自動的に再接続されます。',
    confirm: 'それでも終了',
    cancel: 'キャンセル',
    dontAskAgain: '今後確認しない',
  },
  ko: {
    title: 'AiOpt를 종료할까요?',
    message: '에이전트 {count}개가 AiOpt 프록시를 통해 연결되어 있습니다.',
    detail:
      'AiOpt가 실행되지 않는 동안에는 연결할 수 없습니다. 다음에 AiOpt를 열면 자동으로 다시 연결됩니다.',
    confirm: '그래도 종료',
    cancel: '취소',
    dontAskAgain: '다시 묻지 않기',
  },
  fr: {
    title: 'Quitter AiOpt ?',
    message: '{count} agent(s) passent par le proxy d’AiOpt.',
    detail:
      'Ils ne pourront pas se connecter tant qu’AiOpt n’est pas en cours d’exécution. Ils se reconnecteront automatiquement à la prochaine ouverture d’AiOpt.',
    confirm: 'Quitter quand même',
    cancel: 'Annuler',
    dontAskAgain: 'Ne plus demander',
  },
  de: {
    title: 'AiOpt beenden?',
    message: '{count} Agent(en) laufen über den Proxy von AiOpt.',
    detail:
      'Solange AiOpt nicht läuft, können sie sich nicht verbinden. Beim nächsten Start von AiOpt verbinden sie sich automatisch wieder.',
    confirm: 'Trotzdem beenden',
    cancel: 'Abbrechen',
    dontAskAgain: 'Nicht mehr fragen',
  },
  es: {
    title: '¿Salir de AiOpt?',
    message: '{count} agente(s) están enrutados a través del proxy de AiOpt.',
    detail:
      'Mientras AiOpt no esté en ejecución no podrán conectarse. Se reconectarán automáticamente la próxima vez que abras AiOpt.',
    confirm: 'Salir de todos modos',
    cancel: 'Cancelar',
    dontAskAgain: 'No preguntar de nuevo',
  },
};

/**
 * Map an Electron/config locale string to a supported dialog locale. Delegates to the menu
 * resolver rather than repeating the prefix table: the dialog covers exactly the menu's
 * locales, so a second copy of the rule could only drift from it.
 */
export function resolveQuitDialogLocale(locale: string): QuitDialogLocale {
  return resolveMenuLocale(locale);
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
