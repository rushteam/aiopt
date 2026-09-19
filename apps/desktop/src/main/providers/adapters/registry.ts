// The set of agent adapters AiOpt ships, keyed by agent id.
//
// The bindable agents are wired here (Claude, Codex, dsh, Gemini, Grok, Hermes,
// OpenCode, pi). An agent with no adapter would simply be unbindable — the manager
// treats a missing adapter as an unsupported capability.

import type { AgentId } from '../../../shared/aiProviders';
import type { AgentAdapter } from './agentAdapter';
import { createClaudeAdapter } from './claudeAdapter';
import { createCodexAdapter } from './codexAdapter';
import { createDshAdapter } from './dshAdapter';
import { createGeminiAdapter } from './geminiAdapter';
import { createGrokAdapter } from './grokAdapter';
import { createHermesAdapter } from './hermesAdapter';
import { createOpenCodeAdapter } from './opencodeAdapter';
import { createPiAdapter } from './piAdapter';

export function createAdapterRegistry(): Map<AgentId, AgentAdapter> {
  const adapters: AgentAdapter[] = [
    createClaudeAdapter(),
    createCodexAdapter(),
    createDshAdapter(),
    createGeminiAdapter(),
    createGrokAdapter(),
    createHermesAdapter(),
    createOpenCodeAdapter(),
    createPiAdapter(),
  ];
  return new Map(adapters.map((adapter) => [adapter.def.id, adapter]));
}
