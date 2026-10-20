import { describe, expect, it } from 'vitest';
import { groupImportCandidates } from '../agentImportGroups';
import type { AgentImportCandidate } from '../../../../shared/agentImport';

const c = (agentName: string, over: Partial<AgentImportCandidate> = {}): AgentImportCandidate => ({
  agentId: 'codex',
  agentName,
  available: false,
  accountLabel: null,
  reason: 'not_installed',
  ...over,
});

describe('groupImportCandidates', () => {
  it('splits ready / added / unavailable, names sorted within each', () => {
    const g = groupImportCandidates([
      c('Zed', { available: true }),
      c('codex', { available: true }),
      c('Claude', { available: true, alreadyAdded: true }),
      c('Kiro'),
      c('Grok', { reason: 'not_signed_in' }),
      c('Devin', { reason: 'unsupported' }),
      c('Aider'),
    ]);
    expect(g.ready.map((x) => x.agentName)).toEqual(['codex', 'Zed']);
    expect(g.added.map((x) => x.agentName)).toEqual(['Claude']);
    // signed-out first (one step away), then unsupported, then not installed
    expect(g.unavailable.map((x) => x.agentName)).toEqual(['Grok', 'Devin', 'Aider', 'Kiro']);
  });
});
