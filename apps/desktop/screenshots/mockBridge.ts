// A stand-in `window.aiopt` for the README screenshot harness (see capture.mjs).
//
// DEV-ONLY and outside `src/`, so it is never bundled into the app. It renders the real
// renderer against FIXED DEMO DATA: no IPC, no main process, no user data. Nothing here
// reads the machine it runs on, and the "keys" are only a `hasKey` flag — no secret
// exists anywhere in this file. Typed against AiOptBridge, so a preload change that this
// mock doesn't follow fails typecheck instead of silently drifting.
//
// Query parameters: `theme` (light | dark), `lang` (a LanguagePreference), `tab`
// (providers | usage | skills), `select` (a skill name to open in the Skills detail pane).

import type { AiOptBridge } from '../src/preload/preload';
import type {
  AgentSummary,
  LanguagePreference,
  PreferencesShape,
  ProviderSummary,
  ProvidersSnapshot,
} from '../src/shared/ipc-channels';
import type { UsageBucket, UsageDailyPoint, UsageSnapshot, UsageTotals } from '../src/shared/usageStats';
import type { SkillEntry, SkillMatrixRow, SkillsSnapshot } from '../src/shared/skills';
import { AGENT_SPECS, type AgentId, type AgentSpec } from '../src/shared/aiProviders';
import { MENU_COMMANDS, type MenuCommand } from '../src/shared/menuCommands';

const params = new URLSearchParams(location.search);
const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
const lang = (params.get('lang') ?? 'en') as LanguagePreference;
const tab = params.get('tab');
const select = params.get('select');

// Fixed "now" so every capture shows the same dates.
const NOW = Date.UTC(2026, 8, 24, 12);
const DAY = 86_400_000;

const providers: ProviderSummary[] = [
  {
    id: 'p-anthropic',
    name: 'Anthropic',
    apiFormat: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    models: [{ id: 'claude-opus-4-5' }, { id: 'claude-sonnet-4-5' }, { id: 'claude-haiku-4-5' }],
    createdAt: NOW - 30 * DAY,
    hasKey: true,
  },
  {
    id: 'p-openai',
    name: 'OpenAI',
    apiFormat: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    models: [{ id: 'gpt-5' }, { id: 'gpt-5-mini' }],
    createdAt: NOW - 28 * DAY,
    hasKey: true,
  },
  {
    id: 'p-deepseek',
    name: 'DeepSeek',
    apiFormat: 'openai',
    baseUrl: 'https://api.deepseek.com',
    models: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }],
    createdAt: NOW - 20 * DAY,
    hasKey: true,
  },
  {
    id: 'p-kimi',
    name: 'Moonshot (Kimi)',
    apiFormat: 'anthropic',
    baseUrl: 'https://api.moonshot.cn/anthropic',
    models: [{ id: 'kimi-k2-turbo-preview' }],
    createdAt: NOW - 12 * DAY,
    hasKey: true,
  },
  {
    id: 'p-gemini',
    name: 'Google Gemini',
    apiFormat: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    models: [{ id: 'gemini-2.5-pro' }, { id: 'gemini-2.5-flash' }],
    createdAt: NOW - 6 * DAY,
    hasKey: true,
  },
];

// Codex on a Claude model is the cross-format showcase, so it is the proxied route.
const bindings: Partial<Record<AgentId, { providerId: string; modelId: string; proxied: boolean }>> = {
  claude: { providerId: 'p-anthropic', modelId: 'claude-sonnet-4-5', proxied: false },
  codex: { providerId: 'p-anthropic', modelId: 'claude-opus-4-5', proxied: true },
  dsh: { providerId: 'p-deepseek', modelId: 'deepseek-reasoner', proxied: false },
  gemini: { providerId: 'p-gemini', modelId: 'gemini-2.5-pro', proxied: false },
  hermes: { providerId: 'p-kimi', modelId: 'kimi-k2-turbo-preview', proxied: false },
  opencode: { providerId: 'p-deepseek', modelId: 'deepseek-chat', proxied: false },
};
const notInstalled: ReadonlySet<AgentId> = new Set(['pi']);

const specs = Object.entries(AGENT_SPECS) as [AgentId, AgentSpec][];

const agents: AgentSummary[] = specs.flatMap(([id, spec]) => {
  if (!spec.binding) return [];
  const b = bindings[id];
  return [
    {
      id,
      name: spec.name,
      acceptedFormats: [...spec.binding.acceptedFormats],
      mode: spec.binding.mode,
      installed: !notInstalled.has(id),
      binding: b ? { providerId: b.providerId, modelId: b.modelId } : null,
      proxied: b?.proxied ?? false,
      installDirDisplay: `~/${spec.binding.installDir}`,
      configFiles: Object.entries(spec.binding.files).map(([role, rel]) => ({
        role,
        displayPath: `~/${rel}`,
        exists: b !== undefined,
      })),
    },
  ];
});

const providersSnapshot: ProvidersSnapshot = { providers, agents, proxyPort: 47821 };

// --- Usage: two weeks of proxied traffic, deterministic -------------------------------

function totalsOf(requests: number, errors: number, input: number, output: number): UsageTotals {
  return {
    requests,
    okRequests: requests - errors,
    errorRequests: errors,
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
  };
}

const DAILY_SHAPE = [0.42, 0.55, 0.38, 0.71, 0.8, 0.33, 0.29, 0.64, 0.77, 0.69, 0.92, 1, 0.58, 0.86];
const daily: UsageDailyPoint[] = DAILY_SHAPE.map((f, i) => {
  const requests = Math.round(420 * f);
  const input = Math.round(3_900_000 * f);
  const output = Math.round(610_000 * f);
  const day = new Date(NOW - (DAILY_SHAPE.length - 1 - i) * DAY).toISOString().slice(0, 10);
  return { day, ...totalsOf(requests, i % 5 === 3 ? 3 : 1, input, output) };
});

function sum(points: readonly UsageTotals[]): UsageTotals {
  return points.reduce(
    (acc, p) =>
      totalsOf(
        acc.requests + p.requests,
        acc.errorRequests + p.errorRequests,
        acc.inputTokens + p.inputTokens,
        acc.outputTokens + p.outputTokens,
      ),
    totalsOf(0, 0, 0, 0),
  );
}

const totals = sum(daily);

// Split the totals by fixed shares so every breakdown adds up to the same grand total.
function split(shares: readonly (readonly [string, number])[]): UsageBucket[] {
  return shares.map(([key, f]) => ({
    key,
    ...totalsOf(
      Math.round(totals.requests * f),
      Math.round(totals.errorRequests * f),
      Math.round(totals.inputTokens * f),
      Math.round(totals.outputTokens * f),
    ),
  }));
}

const usageSnapshot: UsageSnapshot = {
  totals,
  daily,
  byProvider: split([
    ['p-anthropic', 0.64],
    ['p-deepseek', 0.27],
    ['p-kimi', 0.09],
  ]),
  byAgent: split([
    ['codex', 0.58],
    ['claude', 0.23],
    ['opencode', 0.19],
  ]),
  byModel: split([
    ['claude-opus-4-5', 0.58],
    ['deepseek-chat', 0.19],
    ['claude-sonnet-4-5', 0.14],
    ['kimi-k2-turbo-preview', 0.09],
  ]),
  since: NOW - 13 * DAY,
  until: NOW,
  retentionDays: 90,
  eventCount: totals.requests,
};

// --- Skills ----------------------------------------------------------------------------

function entry(name: string, description: string, fileCount: number, ageDays: number): SkillEntry {
  return {
    name,
    meta: { name, description },
    fileCount,
    totalBytes: fileCount * 2_300,
    modifiedAt: NOW - ageDays * DAY,
  };
}

const SKILLS: readonly (readonly [name: string, description: string, files: number])[] = [
  ['code-review', 'Review a diff for correctness, security and style before it is merged.', 4],
  ['commit-message', 'Write a conventional commit message from the staged changes.', 2],
  ['release-notes', 'Draft release notes from the merged pull requests since the last tag.', 3],
  ['sql-explain', 'Explain a slow SQL query plan and suggest an index.', 2],
  ['test-writer', 'Add focused unit tests for the function under the cursor.', 5],
];

// Which agents hold each skill, and in what state relative to the library.
const SKILL_CELLS: Record<string, Partial<Record<AgentId, 'same' | 'differs' | 'agent-only'>>> = {
  'code-review': { claude: 'same', codex: 'same', cursor: 'same', opencode: 'differs', gemini: 'same' },
  'commit-message': { claude: 'same', codex: 'same', dsh: 'same', hermes: 'same' },
  'release-notes': { claude: 'differs', cursor: 'same' },
  'sql-explain': { codex: 'agent-only' },
  'test-writer': { claude: 'same', codex: 'same', cursor: 'same', gemini: 'same', opencode: 'same', pi: 'same' },
};

const skillRows: SkillMatrixRow[] = SKILLS.map(([name, description, files], i) => {
  const cells = SKILL_CELLS[name] ?? {};
  const agentOnly = Object.values(cells).every((s) => s === 'agent-only');
  const central = agentOnly ? null : entry(name, description, files, 3 + i);
  const row: SkillMatrixRow = { name, central, agents: {} };
  for (const [id, state] of Object.entries(cells) as [AgentId, 'same' | 'differs' | 'agent-only'][]) {
    // A differing agent copy is the newer one, so the matrix suggests a pull.
    const age = state === 'differs' ? 1 : 3 + i;
    row.agents[id] = { entry: entry(name, description, files, age), state };
  }
  return row;
});

const skillsSnapshot: SkillsSnapshot = {
  libraryLocation: 'home',
  centralPath: '~/.aiopt/skills',
  agents: specs.map(([id, spec]) => ({
    id,
    name: spec.name,
    dir: spec.skillsDir ? `~/${spec.skillsDir}` : null,
    available: spec.skillsDir !== null,
  })),
  rows: skillRows,
  scannedAt: NOW,
};

// --- The bridge ------------------------------------------------------------------------

const prefs: PreferencesShape = {
  theme,
  language: lang,
  skillsLibrary: 'home',
  proxyMode: false,
  warnOnQuitWithProxy: true,
};

const noop = (): void => {};
const unsubscribe = (): (() => void) => noop;
const refused = (): Promise<never> => Promise.reject(new Error('screenshot harness is read-only'));

const bridge: AiOptBridge = {
  platform: 'darwin',
  versions: { electron: '41.2.0', chrome: '', node: '' },
  config: {
    getAll: async () => prefs,
    set: async () => prefs,
    reset: async () => prefs,
    onChanged: unsubscribe,
  },
  secret: { set: refused, has: async () => ({ present: false }), delete: refused },
  theme: { getInitial: () => theme },
  auth: {
    getState: async () => ({ status: 'signed-out', user: null }),
    login: refused,
    logout: refused,
    onStateChanged: unsubscribe,
  },
  update: {
    getStatus: async () => ({ state: 'idle', currentVersion: '1.0.0' }),
    check: refused,
    onStatusChanged: unsubscribe,
  },
  appShortcuts: {
    getState: () => ({ overrides: {}, platform: 'darwin' }),
    setOverride: refused,
    clearOverride: refused,
    resetAll: refused,
    setRecording: noop,
    onChanged: unsubscribe,
  },
  providers: {
    list: async () => providersSnapshot,
    add: refused,
    update: refused,
    remove: refused,
    setBinding: refused,
    clearBinding: refused,
    restoreDefault: refused,
    fetchModels: refused,
    revealKey: refused,
    copyProxyConfig: async () => ({ copied: false }),
    refreshProxyPort: async () => ({ port: 47821 }),
    revealConfig: refused,
    onChanged: unsubscribe,
  },
  usage: { get: async () => usageSnapshot, clear: refused, onChanged: unsubscribe },
  skills: {
    get: async () => skillsSnapshot,
    pull: refused,
    push: refused,
    import: refused,
    delete: refused,
    deleteAgent: refused,
    diff: refused,
    fileContent: refused,
    merge: refused,
    reveal: refused,
    onChanged: unsubscribe,
  },
  getVersions: async () => ({ app: '1.0.0', electron: '41.2.0', chrome: '', node: '' }),
  quit: noop,
  // The tab is picked through the same menu command a user's menu click sends.
  onMenuCommand: (callback: (command: MenuCommand) => void) => {
    const command =
      tab === 'usage' ? MENU_COMMANDS.showUsage : tab === 'skills' ? MENU_COMMANDS.showSkills : null;
    if (command) queueMicrotask(() => callback(command));
    return noop;
  },
};

window.aiopt = bridge;

// Open a skill's detail pane by clicking its matrix row, once the rows have rendered.
if (select) {
  const timer = setInterval(() => {
    const row = [...document.querySelectorAll('button')].find(
      (b) => b.firstElementChild?.textContent === select,
    );
    if (row) {
      clearInterval(timer);
      row.click();
    }
  }, 50);
}
