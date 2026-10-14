// Named snapshots of all agent bindings — switch setups in one action.

import type { AgentBinding, AgentId } from './aiProviders';

/** Default profile name when the user saves without picking another label. */
export const DEFAULT_BINDING_PROFILE_NAME = 'default';

export interface BindingProfile {
  id: string;
  name: string;
  createdAt: number;
  bindings: Partial<Record<AgentId, AgentBinding>>;
  /**
   * Per MCP agent, the library servers enabled for it when the profile was saved. Absent
   * (profiles saved before MCP existed) means applying the profile leaves MCP alone.
   */
  mcp?: Partial<Record<string, string[]>>;
}

export interface BindingProfileSummary {
  id: string;
  name: string;
  createdAt: number;
  /** How many agents have a binding in this profile. */
  boundCount: number;
  /** Total enabled MCP server entries recorded, or null when the profile has no MCP part. */
  mcpCount: number | null;
}

/** Result of applying a profile. `applied: false` — the user declined the MCP write. */
export interface BindingProfileApplyResult {
  snapshot: import('./ipc-channels').ProvidersSnapshot;
  applied: boolean;
  /** MCP entries in the profile skipped because the server is gone or unsupported. */
  mcpSkipped: number;
}
