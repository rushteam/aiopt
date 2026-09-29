// Bindable-agent adapters — one factory per {@link BindableAgentId}.
//
// TypeScript enforces exhaustiveness: add `binding` in AGENT_SPECS → you must add a
// matching key here (see `docs/dev-rules/add-bindable-agent.md`).

import type { AgentId, BindableAgentId } from '../../../shared/aiProviders';
import type { AgentAdapter } from './agentAdapter';
import { createClaudeAdapter } from './claudeAdapter';
import { createCodexAdapter } from './codexAdapter';
import { createDshAdapter } from './dshAdapter';
import { createGeminiAdapter } from './geminiAdapter';
import { createGrokAdapter } from './grokAdapter';
import { createHermesAdapter } from './hermesAdapter';
import { createOpenCodeAdapter } from './opencodeAdapter';
import { createPiAdapter } from './piAdapter';

/** The only registration table for bindable agents — keys must cover every {@link BindableAgentId}. */
export const BINDABLE_ADAPTER_FACTORIES = {
  claude: createClaudeAdapter,
  codex: createCodexAdapter,
  dsh: createDshAdapter,
  gemini: createGeminiAdapter,
  grok: createGrokAdapter,
  hermes: createHermesAdapter,
  opencode: createOpenCodeAdapter,
  pi: createPiAdapter,
} satisfies { [K in BindableAgentId]: () => AgentAdapter };

export function createAdapterRegistry(): Map<AgentId, AgentAdapter> {
  const entries = Object.entries(BINDABLE_ADAPTER_FACTORIES) as [
    BindableAgentId,
    () => AgentAdapter,
  ][];
  return new Map(
    entries.map(([id, factory]) => {
      const adapter = factory();
      if (adapter.def.id !== id) {
        throw new Error(`adapter factory for "${id}" returned def.id "${adapter.def.id}"`);
      }
      return [id, adapter];
    }),
  );
}
