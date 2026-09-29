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
};
