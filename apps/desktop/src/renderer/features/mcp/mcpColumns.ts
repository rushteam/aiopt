import type { McpAgentInfo, McpMatrixRow } from '../../../shared/mcp';

/**
 * The agents that get a matrix column: installed ones, plus any whose file already has a
 * server (or that the user must hear about because the file is unreadable). Seven fixed
 * columns would mostly be empty for agents the user never installed.
 */
export function visibleMcpAgents(agents: McpAgentInfo[], rows: McpMatrixRow[]): McpAgentInfo[] {
  return agents.filter(
    (a) => a.installed || a.unreadable || rows.some((r) => r.agents[a.agentId]?.entry != null),
  );
}
