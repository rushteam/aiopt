// MCP servers share a file with the provider binding for Codex (`config.toml`), Gemini
// (`settings.json`), OpenCode / OpenChamber (`opencode.json`, key `mcp`) and Hermes
// (`config.yaml`, key `mcp_servers`). The binding adapters rewrite that file on apply and roll it back from
// `*.aiopt.bak` on restore; both would silently drop or revert the user's MCP servers. These
// helpers carry the CURRENT MCP section across either operation, so binding a provider never
// changes which MCP servers an agent has.

import fs from 'node:fs';
import { isMap, parseDocument } from 'yaml';
import { assertAgentConfigPath, atomicWriteFile } from '../providers/fsutil';
import { extractMcpBlocks, stripMcpBlocks } from './codexToml';

function readOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf-8').replace(/^\uFEFF/, '');
  } catch {
    return null;
  }
}

function modeOf(file: string): number | undefined {
  try {
    return fs.statSync(file).mode & 0o777;
  } catch {
    return undefined;
  }
}

/** Append the `[mcp_servers.*]` blocks of the file currently on disk to a freshly rendered TOML. */
export function withCodexMcpBlocks(file: string, rendered: string): string {
  const blocks = extractMcpBlocks(readOrNull(file) ?? '');
  return blocks === '' ? rendered : `${rendered.replace(/\n*$/, '')}\n\n${blocks}\n`;
}

/** Run `restore` on a Codex `config.toml`; its MCP blocks end up as they were before. */
export function restoreKeepingCodexMcp(file: string, restore: () => void): void {
  const before = readOrNull(file);
  const blocks = extractMcpBlocks(before ?? '');
  restore();
  const after = readOrNull(file);
  if (after === null && blocks === '') return;
  // Drop the restored file's own MCP blocks (an older set), then put the current ones back.
  const withoutMcp = stripMcpBlocks(after ?? '');
  const next =
    blocks === '' ? withoutMcp : withoutMcp.trim() === '' ? `${blocks}\n` : `${withoutMcp.replace(/\n*$/, '')}\n\n${blocks}\n`;
  if (next === after) return;
  assertAgentConfigPath(file);
  atomicWriteFile(file, next, modeOf(file) ?? 0o600);
}

/**
 * Run `restore` on a JSON config whose MCP servers live under `section` (Gemini `mcpServers`,
 * OpenCode `mcp`); that section ends up as it was before.
 */
export function restoreKeepingJsonMcp(file: string, restore: () => void, section = 'mcpServers'): void {
  const before = readOrNull(file);
  let current: unknown;
  try {
    const parsed: unknown = before === null ? {} : JSON.parse(before);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    current = (parsed as Record<string, unknown>)[section];
  } catch {
    // The current file is not readable JSON: we cannot tell what to keep; plain restore.
    restore();
    return;
  }
  restore();
  const after = readOrNull(file);
  if (after === null && current === undefined) return;
  let restored: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(after ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    restored = parsed as Record<string, unknown>;
  } catch {
    // An unparseable restored original would not have been loadable by the agent either.
    return;
  }
  const { [section]: _old, ...rest } = restored;
  const next = current === undefined ? rest : { ...rest, [section]: current };
  if (current === undefined && _old === undefined) return;
  assertAgentConfigPath(file);
  atomicWriteFile(file, `${JSON.stringify(next, null, 2)}\n`, modeOf(file) ?? 0o600);
}

/** Run `restore` on Hermes `config.yaml`; its `mcp_servers` ends up as it was before. */
export function restoreKeepingYamlMcp(file: string, restore: () => void, section = 'mcp_servers'): void {
  const before = parseDocument(readOrNull(file) ?? '');
  if (before.errors.length > 0 || (before.contents !== null && !isMap(before.contents))) {
    // Not a YAML map: we cannot tell what to keep; plain restore.
    restore();
    return;
  }
  const current = before.get(section, true);
  restore();
  const afterText = readOrNull(file);
  if (afterText === null && current === undefined) return;
  const after = parseDocument(afterText ?? '');
  // An unparseable restored original would not have been loadable by the agent either.
  if (after.errors.length > 0 || (after.contents !== null && !isMap(after.contents))) return;
  if (current === undefined && !after.has(section)) return;
  if (current === undefined) after.delete(section);
  else after.set(section, current);
  const next = after.toString();
  if (next === afterText) return;
  assertAgentConfigPath(file);
  atomicWriteFile(file, next, modeOf(file) ?? 0o600);
}
