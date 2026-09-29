import type { AgentAdapter } from './adapters/agentAdapter';
import { bindingDriftDetected } from './adapters/bindingLive';
import type { AppliedBindingRecord } from './bindingAppliedStore';

/**
 * True when the agent's config no longer matches what AiOpt last applied (another tool
 * edited it, or a partial write failed). Delegates disk readback to the agent adapter —
 * each agent stores bindings in a different shape; see `docs/dev-rules/agent-binding-drift.md`.
 */
export function detectBindingDrift(
  adapter: AgentAdapter | undefined,
  applied: AppliedBindingRecord | null,
): boolean {
  if (!applied || !adapter) return false;
  return bindingDriftDetected(applied, adapter.readLiveBinding(applied));
}
