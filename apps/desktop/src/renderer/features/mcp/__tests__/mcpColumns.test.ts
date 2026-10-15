import { describe, expect, it } from 'vitest';
import { visibleMcpAgents } from '../mcpColumns';
import type { McpAgentInfo, McpMatrixRow } from '../../../../shared/mcp';

const info = (agentId: McpAgentInfo['agentId'], installed: boolean, unreadable = false): McpAgentInfo => ({
  agentId,
  installed,
  unreadable,
  configDisplayPath: '~/x',
});

describe('visibleMcpAgents', () => {
  it('keeps installed agents, unreadable ones, and agents whose file already has a server', () => {
    const agents = [info('claude', true), info('cursor', false), info('pi', false), info('hermes', false, true)];
    const rows: McpMatrixRow[] = [
      {
        name: 'fs',
        library: null,
        agents: {
          cursor: { state: 'agent-only', supported: true, entry: { transport: 'stdio', command: 'x', args: [], envKeys: [], headerKeys: [] } },
          pi: { state: 'library-only', supported: true, entry: null },
        },
      },
    ];
    expect(visibleMcpAgents(agents, rows).map((a) => a.agentId)).toEqual(['claude', 'cursor', 'hermes']);
  });
});
