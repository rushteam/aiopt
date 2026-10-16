// Default provider shape when importing an agent session into the pool.

import type { ApiFormat, ProviderModel } from './aiProviders';
import type { AgentImportAgentId } from './agentImport';

export interface AgentImportProviderTemplate {
  agentId: AgentImportAgentId;
  name: string;
  baseUrl: string;
  apiFormats: ApiFormat[];
  models: ProviderModel[];
}

/** Upstream bases aligned with how each agent talks to its vendor. */
export const AGENT_IMPORT_PROVIDER_TEMPLATES: Record<AgentImportAgentId, AgentImportProviderTemplate> = {
  codex: {
    agentId: 'codex',
    name: 'ChatGPT (Codex sign-in)',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    apiFormats: ['openai-responses'],
    models: [{ id: 'gpt-5' }],
  },
  claude: {
    agentId: 'claude',
    name: 'Claude (Claude Code sign-in)',
    baseUrl: 'https://api.anthropic.com',
    apiFormats: ['anthropic'],
    models: [{ id: 'claude-sonnet-4-20250514' }],
  },
  copilot: {
    agentId: 'copilot',
    name: 'GitHub Copilot (sign-in)',
    baseUrl: 'https://api.githubcopilot.com',
    apiFormats: ['openai'],
    models: [{ id: 'gpt-4o' }],
  },
  grok: {
    agentId: 'grok',
    name: 'Grok (SuperGrok sign-in)',
    baseUrl: 'https://cli-chat-proxy.grok.com/v1',
    apiFormats: ['openai-responses'],
    models: [{ id: 'grok-4.7' }],
  },
  devin: {
    agentId: 'devin',
    name: 'Devin (CLI sign-in)',
    baseUrl: 'https://server.codeium.com',
    apiFormats: ['openai'],
    models: [{ id: 'claude-sonnet-4-6' }],
  },
  gemini: {
    agentId: 'gemini',
    name: 'Gemini CLI (Google sign-in)',
    baseUrl: 'https://cloudcode-pa.googleapis.com',
    apiFormats: ['gemini'],
    models: [{ id: 'gemini-2.5-pro' }],
  },
  cursor: {
    agentId: 'cursor',
    name: 'Cursor (sign-in)',
    baseUrl: 'https://api2.cursor.sh',
    apiFormats: ['openai'],
    models: [{ id: 'auto' }],
  },
  // dsh stores a plain DeepSeek API key (no subscription sign-in), so this is DeepSeek's
  // public OpenAI-compatible API.
  dsh: {
    agentId: 'dsh',
    name: 'DeepSeek (dsh API key)',
    baseUrl: 'https://api.deepseek.com',
    apiFormats: ['openai'],
    models: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }],
  },
  // Command Code's CLI keeps a plain Provider API key in ~/.commandcode/auth.json. Its
  // Provider API serves the open models on Chat Completions and Claude on Messages.
  commandcode: {
    agentId: 'commandcode',
    name: 'Command Code (CLI sign-in)',
    baseUrl: 'https://api.commandcode.ai/provider/v1',
    apiFormats: ['openai', 'anthropic'],
    models: [
      { id: 'deepseek/deepseek-v4-pro' },
      { id: 'zai-org/GLM-5.3' },
      { id: 'moonshotai/Kimi-K3' },
      { id: 'claude-sonnet-5' },
    ],
  },
  // ZCode keeps its GLM Coding Plan key (encrypted) in ~/.zcode/v2/credentials.json; the
  // plan is served on Anthropic Messages. The base is Z.ai's unless the key is BigModel's
  // (resolved at import — see agentImportService).
  zcode: {
    agentId: 'zcode',
    name: 'ZCode (GLM Coding Plan)',
    baseUrl: 'https://api.z.ai/api/anthropic',
    apiFormats: ['anthropic'],
    models: [{ id: 'GLM-5.3' }, { id: 'GLM-5.3-Flash' }, { id: 'GLM-5.2' }, { id: 'GLM-5-Turbo' }],
  },
  // WorkBuddy desktop's sign-in, served by the WorkBuddy upstream driver (its own headers,
  // streamed Chat Completions at <endpoint>/v2).
  workbuddy: {
    agentId: 'workbuddy',
    name: 'WorkBuddy (desktop sign-in)',
    baseUrl: 'https://copilot.tencent.com/v2',
    apiFormats: ['openai'],
    models: [{ id: 'auto' }, { id: 'glm-5.3' }, { id: 'kimi-k3-1' }, { id: 'deepseek-v4-pro' }],
  },
  // kiro-cli's / the Kiro IDE's sign-in, served by the Kiro upstream driver (its own
  // conversation API and AWS event stream; the base is fixed by the driver).
  kiro: {
    agentId: 'kiro',
    name: 'Kiro (sign-in)',
    baseUrl: 'https://runtime.us-east-1.kiro.dev',
    apiFormats: ['openai'],
    models: [{ id: 'auto' }],
  },
};
