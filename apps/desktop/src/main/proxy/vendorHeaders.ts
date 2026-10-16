// Extra outbound headers some imported sign-ins need on the ordinary HTTP path.
//
// Most providers take the key one way per dialect (outboundHeaders in ./upstream.ts). A few
// imported sign-ins want it both ways, or want their client's identity:
//   - Command Code's Provider API: the key as a bearer token AND as x-api-key, with the CLI's
//     version headers (magpie's Command Code plugin).
//   - ZCode's GLM Coding Plan key: bearer AND x-api-key, on either dialect.
// Merged over outboundHeaders' result. Pure: unit-tested in __tests__/vendorHeaders.test.ts.
// The returned map carries the key — never log it.

import type { AgentImportAgentId } from '../../shared/agentImport';

export const COMMAND_CODE_CLI_VERSION = '1.72.2';

export function vendorHeaders(agentId: AgentImportAgentId | undefined, apiKey: string | null): Record<string, string> {
  if (!apiKey) return {};
  switch (agentId) {
    case 'commandcode':
      return {
        authorization: `Bearer ${apiKey}`,
        'x-api-key': apiKey,
        'x-command-code-version': COMMAND_CODE_CLI_VERSION,
        'x-cli-environment': 'production',
      };
    case 'zcode':
      return { authorization: `Bearer ${apiKey}`, 'x-api-key': apiKey };
    default:
      return {};
  }
}
