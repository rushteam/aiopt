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
  /** Several servers in one dialog (applying a config profile). `{count}` is replaced. */
  messageMany: string;
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
    messageMany: 'Add {count} MCP servers to your agents?',
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
    messageMany: '要把 {count} 个 MCP 服务器写入 agent 吗？',
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
    messageMany: '{count} 個の MCP サーバーをエージェントに追加しますか？',
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
    messageMany: 'MCP 서버 {count}개를 에이전트에 추가할까요?',
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
    messageMany: 'Ajouter {count} serveurs MCP à vos agents ?',
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
    messageMany: '{count} MCP-Server zu Ihren Agenten hinzufügen?',
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
    messageMany: '¿Añadir {count} servidores MCP a tus agentes?',
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

/** Total detail budget when several servers share one dialog. */
const MAX_DETAIL_TOTAL = 6000;

const agentNames = (req: McpConfirmRequest): string => req.agentIds.map((a) => AGENT_SPECS[a].name).join(', ');

function specLines(l: McpConfirmLabels, req: McpConfirmRequest, max: number): string[] {
  const spec = req.summary.length > max ? `${req.summary.slice(0, max)}…` : req.summary;
  const lines = [`${req.transport === 'stdio' ? l.command : l.url}:`, spec];
  if (req.envKeys.length > 0) lines.push(`${l.env}: ${req.envKeys.join(', ')}`);
  if (req.headerKeys.length > 0) lines.push(`${l.headers}: ${req.headerKeys.join(', ')}`);
  return lines;
}

/** One request: the server's own dialog. Several: every server with its agents, then the note. */
export function buildMcpConfirm(locale: string, reqs: McpConfirmRequest[]): McpConfirmContent {
  const l = MCP_CONFIRM_LABELS[resolveMenuLocale(locale)];
  if (reqs.length === 1) {
    const req = reqs[0]!;
    return {
      title: l.title,
      message: l.message.replace('{name}', req.name).replace('{agents}', agentNames(req)),
      detail: [...specLines(l, req, MAX_DETAIL_SPEC), '', l.note].join('\n'),
      confirm: l.confirm,
      cancel: l.cancel,
    };
  }
  // Every server is always listed by name; only each spec is shortened to fit the budget.
  const perSpec = Math.max(80, Math.min(MAX_DETAIL_SPEC, Math.floor(MAX_DETAIL_TOTAL / Math.max(1, reqs.length))));
  const blocks = reqs.map((req) => [`${req.name} → ${agentNames(req)}`, ...specLines(l, req, perSpec)].join('\n'));
  return {
    title: l.title,
    message: l.messageMany.replace('{count}', String(reqs.length)),
    detail: [...blocks, l.note].join('\n\n'),
    confirm: l.confirm,
    cancel: l.cancel,
  };
}

/** The gateway dialog: AiOpt ITSELF will run the command / connect, not an agent. */
export interface McpGatewayConfirmLabels {
  title: string;
  /** `{name}` is replaced. */
  message: string;
  note: string;
  confirm: string;
}

export const MCP_GATEWAY_CONFIRM_LABELS: Record<MenuLocale, McpGatewayConfirmLabels> = {
  en: {
    title: 'Serve through the MCP gateway',
    message: 'Let AiOpt run MCP server “{name}” for the MCP gateway?',
    note: 'AiOpt will run this command or connect to this URL itself, with the stored values, whenever an agent uses one of its tools. Only continue if you trust it.',
    confirm: 'Allow',
  },
  'zh-CN': {
    title: '通过 MCP 网关提供',
    message: '要让 AiOpt 为 MCP 网关运行 MCP 服务器「{name}」吗？',
    note: '每当 agent 使用它的工具时，AiOpt 会自己运行这条命令或连接这个 URL，并带上已保存的值。仅在你信任它时继续。',
    confirm: '允许',
  },
  ja: {
    title: 'MCP ゲートウェイ経由で提供',
    message: 'MCP ゲートウェイのために AiOpt が MCP サーバー「{name}」を実行しますか？',
    note: 'エージェントがそのツールを使うたびに、AiOpt 自身が保存済みの値でこのコマンドを実行するか、この URL に接続します。信頼できる場合のみ続行してください。',
    confirm: '許可',
  },
  ko: {
    title: 'MCP 게이트웨이로 제공',
    message: 'MCP 게이트웨이를 위해 AiOpt가 MCP 서버 “{name}”을(를) 실행할까요?',
    note: '에이전트가 이 서버의 도구를 쓸 때마다 AiOpt가 저장된 값으로 이 명령을 직접 실행하거나 이 URL에 연결합니다. 신뢰하는 경우에만 계속하세요.',
    confirm: '허용',
  },
  fr: {
    title: 'Servir via la passerelle MCP',
    message: 'Laisser AiOpt exécuter le serveur MCP « {name} » pour la passerelle MCP ?',
    note: 'AiOpt exécutera lui-même cette commande ou se connectera à cette URL, avec les valeurs enregistrées, chaque fois qu’un agent utilise l’un de ses outils. Ne continuez que si vous lui faites confiance.',
    confirm: 'Autoriser',
  },
  de: {
    title: 'Über das MCP-Gateway bereitstellen',
    message: 'Soll AiOpt den MCP-Server „{name}“ für das MCP-Gateway ausführen?',
    note: 'AiOpt führt diesen Befehl selbst aus oder verbindet sich mit dieser URL, mit den gespeicherten Werten, sobald ein Agent eines seiner Tools nutzt. Fahren Sie nur fort, wenn Sie ihm vertrauen.',
    confirm: 'Zulassen',
  },
  es: {
    title: 'Servir a través de la pasarela MCP',
    message: '¿Permitir que AiOpt ejecute el servidor MCP «{name}» para la pasarela MCP?',
    note: 'AiOpt ejecutará este comando o se conectará a esta URL por sí mismo, con los valores guardados, cada vez que un agente use una de sus herramientas. Continúa solo si confías en él.',
    confirm: 'Permitir',
  },
};

export function buildMcpGatewayConfirm(locale: string, req: McpConfirmRequest): McpConfirmContent {
  const menuLocale = resolveMenuLocale(locale);
  const l = MCP_CONFIRM_LABELS[menuLocale];
  const g = MCP_GATEWAY_CONFIRM_LABELS[menuLocale];
  return {
    title: g.title,
    message: g.message.replace('{name}', req.name),
    detail: [...specLines(l, req, MAX_DETAIL_SPEC), '', g.note].join('\n'),
    confirm: g.confirm,
    cancel: l.cancel,
  };
}
