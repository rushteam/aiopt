// Bindable-agent adapters — one factory per {@link BindableAgentId}.
//
// TypeScript enforces exhaustiveness: add `binding` in AGENT_SPECS → you must add a
// matching key here (see `docs/dev-rules/add-bindable-agent.md`).

import type { AgentId, BindableAgentId } from '../../../shared/aiProviders';
import type { AgentAdapter } from './agentAdapter';
import { createClineAdapter } from './clineAdapter';
import { createClaudeAdapter } from './claudeAdapter';
import { createCodexAdapter } from './codexAdapter';
import { createCommandCodeAdapter } from './commandcodeAdapter';
import { createCrushAdapter } from './crushAdapter';
import { createDroidAdapter } from './droidAdapter';
import { createDshAdapter } from './dshAdapter';
import { createFxAdapter } from './fxAdapter';
import { createGeminiAdapter } from './geminiAdapter';
import { createGrokAdapter } from './grokAdapter';
import { createHermesAdapter } from './hermesAdapter';
import { createKimiCodeAdapter } from './kimicodeAdapter';
import { createMimoCodeAdapter } from './mimocodeAdapter';
import { createOmoAdapter } from './omoAdapter';
import { createOmpAdapter } from './ompAdapter';
import { createOpenChamberAdapter } from './openchamberAdapter';
import { createOpenCodeAdapter } from './opencodeAdapter';
import { createPiAdapter } from './piAdapter';
import { createQoderAdapter, createQoderCnAdapter } from './qoderAdapter';
import { createWorkBuddyAdapter } from './workbuddyAdapter';
import { createZCodeAdapter } from './zcodeAdapter';

/** The only registration table for bindable agents — keys must cover every {@link BindableAgentId}. */
export const BINDABLE_ADAPTER_FACTORIES = {
  claude: createClaudeAdapter,
  cline: createClineAdapter,
  codex: createCodexAdapter,
  commandcode: createCommandCodeAdapter,
  crush: createCrushAdapter,
  droid: createDroidAdapter,
  dsh: createDshAdapter,
  fx: createFxAdapter,
  gemini: createGeminiAdapter,
  grok: createGrokAdapter,
  hermes: createHermesAdapter,
  kimicode: createKimiCodeAdapter,
  mimocode: createMimoCodeAdapter,
  omo: createOmoAdapter,
  omp: createOmpAdapter,
  openchamber: createOpenChamberAdapter,
  opencode: createOpenCodeAdapter,
  pi: createPiAdapter,
  qoder: createQoderAdapter,
  qodercn: createQoderCnAdapter,
  workbuddy: createWorkBuddyAdapter,
  zcode: createZCodeAdapter,
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
