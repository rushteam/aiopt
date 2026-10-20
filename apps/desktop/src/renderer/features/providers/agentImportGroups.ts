// Agent import dialog: split a scan into what can be imported now, what is already a
// provider, and what isn't ready (not installed / not signed in / unsupported). Pure so
// the order is testable; names sort within a group so a long list is scannable.

import type { AgentImportCandidate } from '../../../shared/agentImport';

export interface AgentImportGroups {
  ready: AgentImportCandidate[];
  added: AgentImportCandidate[];
  unavailable: AgentImportCandidate[];
}

const REASON_ORDER = { not_signed_in: 0, unsupported: 1, not_installed: 2 } as const;

const byName = (a: AgentImportCandidate, b: AgentImportCandidate): number =>
  a.agentName.localeCompare(b.agentName, undefined, { sensitivity: 'base' });

export function groupImportCandidates(candidates: AgentImportCandidate[]): AgentImportGroups {
  const ready = candidates.filter((c) => c.available && !c.alreadyAdded).sort(byName);
  const added = candidates.filter((c) => c.alreadyAdded).sort(byName);
  const unavailable = candidates
    .filter((c) => !c.available && !c.alreadyAdded)
    .sort(
      (a, b) =>
        REASON_ORDER[a.reason ?? 'not_signed_in'] - REASON_ORDER[b.reason ?? 'not_signed_in'] || byName(a, b),
    );
  return { ready, added, unavailable };
}
