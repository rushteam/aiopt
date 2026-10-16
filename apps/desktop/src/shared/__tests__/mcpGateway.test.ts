import { describe, expect, it } from 'vitest';
import { GATEWAY_TOOL_NAME_MAX, buildToolTable, gatewayToolName } from '../mcpGateway';

describe('gatewayToolName', () => {
  it('prefixes plain names unchanged', () => {
    expect(gatewayToolName('github', 'create_issue')).toBe('github__create_issue');
  });

  it('sanitizes unsafe characters and keeps sanitized names apart', () => {
    const a = gatewayToolName('docs.search', 'find');
    const b = gatewayToolName('docs_search', 'find');
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(b).toBe('docs_search__find');
    expect(a).not.toBe(b);
  });

  it('caps long names deterministically and uniquely', () => {
    const long = 'x'.repeat(80);
    const a = gatewayToolName('server', `${long}a`);
    const b = gatewayToolName('server', `${long}b`);
    expect(a.length).toBeLessThanOrEqual(GATEWAY_TOOL_NAME_MAX);
    expect(a).not.toBe(b);
    expect(gatewayToolName('server', `${long}a`)).toBe(a);
  });
});

describe('buildToolTable', () => {
  it('merges servers, routes back to the original names, and labels descriptions', () => {
    const table = buildToolTable([
      { server: 'a', tools: [{ name: 'search', description: 'Find things' }] },
      { server: 'b', tools: [{ name: 'search' }, { name: '' }] },
    ]);
    expect(table.tools.map((t) => t.name)).toEqual(['a__search', 'b__search']);
    expect(table.tools[0]!.description).toBe('[a] Find things');
    expect(table.tools[1]!.description).toBe('[b]');
    expect(table.routes.get('b__search')).toEqual({ server: 'b', tool: 'search' });
  });

  it('keeps the first of a colliding exposed name', () => {
    const table = buildToolTable([
      { server: 'a', tools: [{ name: 'b__c' }] },
      { server: 'a__b', tools: [{ name: 'c' }] },
    ]);
    expect(table.tools).toHaveLength(1);
    expect(table.routes.get('a__b__c')).toEqual({ server: 'a', tool: 'b__c' });
  });
});
