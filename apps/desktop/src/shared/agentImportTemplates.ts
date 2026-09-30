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
};
