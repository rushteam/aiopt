// The native confirmation shown before an MCP server spec is written into an agent's config.
//
// Why native and main-side: an MCP stdio server is a command the agent will RUN. If a
// renderer bug (XSS) could save one silently, it could make every agent launch an arbitrary
// program. The renderer can call `mcp:save`, but it cannot answer an OS dialog, so a human
// always sees the exact command / URL first. Electron-free so the copy is unit-testable; the
// dialog itself is shown by registerHandlers.

import { resolveMenuLocale, type MenuLocale } from '../menu/menuLabels';
import { AGENT_SPECS } from '../../shared/aiProviders';
import type { McpConfirmRequest } from './mcpStore';

export interface McpConfirmLabels {
  title: string;
  /** `{name}` and `{agents}` are replaced. */
  message: string;
  command: string;
  url: string;
  env: string;
  headers: string;
  note: string;
  confirm: string;
  cancel: string;
}

export const MCP_CONFIRM_LABELS: Record<MenuLocale, McpConfirmLabels> = {
  en: {
    title: 'Write MCP server',
    message: 'Add MCP server “{name}” to {agents}?',
    command: 'Command',
    url: 'URL',
    env: 'Environment variables',
    headers: 'Headers',
    note: 'The agent will run this command or connect to this URL. Only continue if you trust it.',
    confirm: 'Write',
    cancel: 'Cancel',
  },
  'zh-CN': {
    title: '写入 MCP 服务器',
    message: '要把 MCP 服务器「{name}」写入 {agents} 吗？',
    command: '命令',
    url: 'URL',
    env: '环境变量',
    headers: '请求头',
    note: 'agent 会运行这条命令或连接这个 URL。仅在你信任它时继续。',
    confirm: '写入',
    cancel: '取消',
  },
  ja: {
    title: 'MCP サーバーを書き込む',
    message: 'MCP サーバー「{name}」を {agents} に追加しますか？',
    command: 'コマンド',
    url: 'URL',
    env: '環境変数',
    headers: 'ヘッダー',
    note: 'エージェントはこのコマンドを実行するか、この URL に接続します。信頼できる場合のみ続行してください。',
    confirm: '書き込む',
    cancel: 'キャンセル',
  },
  ko: {
    title: 'MCP 서버 쓰기',
    message: 'MCP 서버 “{name}”을(를) {agents}에 추가할까요?',
    command: '명령',
    url: 'URL',
    env: '환경 변수',
    headers: '헤더',
    note: '에이전트가 이 명령을 실행하거나 이 URL에 연결합니다. 신뢰하는 경우에만 계속하세요.',
    confirm: '쓰기',
    cancel: '취소',
  },
  fr: {
    title: 'Écrire le serveur MCP',
    message: 'Ajouter le serveur MCP « {name} » à {agents} ?',
    command: 'Commande',
    url: 'URL',
    env: 'Variables d’environnement',
    headers: 'En-têtes',
    note: 'L’agent exécutera cette commande ou se connectera à cette URL. Ne continuez que si vous lui faites confiance.',
    confirm: 'Écrire',
    cancel: 'Annuler',
  },
  de: {
    title: 'MCP-Server schreiben',
    message: 'MCP-Server „{name}“ zu {agents} hinzufügen?',
    command: 'Befehl',
    url: 'URL',
    env: 'Umgebungsvariablen',
    headers: 'Header',
    note: 'Der Agent führt diesen Befehl aus oder verbindet sich mit dieser URL. Fahren Sie nur fort, wenn Sie ihm vertrauen.',
    confirm: 'Schreiben',
    cancel: 'Abbrechen',
  },
  es: {
    title: 'Escribir servidor MCP',
    message: '¿Añadir el servidor MCP «{name}» a {agents}?',
    command: 'Comando',
    url: 'URL',
    env: 'Variables de entorno',
    headers: 'Encabezados',
    note: 'El agente ejecutará este comando o se conectará a esta URL. Continúa solo si confías en él.',
    confirm: 'Escribir',
    cancel: 'Cancelar',
  },
};

export interface McpConfirmContent {
  title: string;
  message: string;
  detail: string;
  confirm: string;
  cancel: string;
}

/** Long specs are cut so the dialog stays readable; the cut is marked, never silent. */
const MAX_DETAIL_SPEC = 2000;

export function buildMcpConfirm(locale: string, req: McpConfirmRequest): McpConfirmContent {
  const l = MCP_CONFIRM_LABELS[resolveMenuLocale(locale)];
  const agents = req.agentIds.map((a) => AGENT_SPECS[a].name).join(', ');
  const spec = req.summary.length > MAX_DETAIL_SPEC ? `${req.summary.slice(0, MAX_DETAIL_SPEC)}…` : req.summary;
  const lines = [`${req.transport === 'stdio' ? l.command : l.url}:`, spec];
  if (req.envKeys.length > 0) lines.push('', `${l.env}: ${req.envKeys.join(', ')}`);
  if (req.headerKeys.length > 0) lines.push('', `${l.headers}: ${req.headerKeys.join(', ')}`);
  lines.push('', l.note);
  return {
    title: l.title,
    message: l.message.replace('{name}', req.name).replace('{agents}', agents),
    detail: lines.join('\n'),
    confirm: l.confirm,
    cancel: l.cancel,
  };
}
