// Named snapshots of all agent bindings — switch setups in one action.

import type { AgentBinding, AgentId } from './aiProviders';

export interface BindingProfile {
  id: string;
  name: string;
  createdAt: number;
  bindings: Partial<Record<AgentId, AgentBinding>>;
}

export interface BindingProfileSummary {
  id: string;
  name: string;
  createdAt: number;
  /** How many agents have a binding in this profile. */
  boundCount: number;
}
