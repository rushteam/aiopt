// Skills IPC — the renderer-facing surface of the skills store.
//
// This is a HIGH-RISK authorization face: the operations behind it read, copy, overwrite, and
// delete directories anywhere under the user's home. So every handler follows the discipline in
// the security rule §5 to the letter: authorize the sender FIRST, then validate the payload at
// runtime (agentId ∈ AGENT_IDS, name is a safe single segment) BEFORE any path is resolved or
// any side effect runs. The renderer NEVER supplies a path — only symbolic coordinates — and the
// two boundary-crossing operations are kept in main: `import`'s source comes from a main-side
// folder picker (injected `pickImportDir`), and `reveal` only ever opens a directory the store
// resolved from its own base dirs (injected `openPath`). Errors go out as coded `throwIpcError`s.

import type { IpcHandlerRegistry } from '../ipc/registry';
import { requireEnum, requireObject, requireString, throwIpcError } from '../ipc/validate';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import { AGENT_IDS, type AgentId } from '../../shared/aiProviders';
import { isValidSkillName } from '../../shared/skills';
import type { SkillsStore } from './skillsStore';

/** Injected boundary-crossing effects, so the handlers unit-test without Electron. */
export interface SkillsIpcDeps {
  /** Open a main-side folder picker; resolves to the chosen absolute path, or null if cancelled. */
  pickImportDir: () => Promise<string | null>;
  /** Open an absolute directory in the OS file manager. */
  openPath: (dir: string) => Promise<void>;
}

/** A skill name that already passed the shared traversal guard, or a coded rejection. */
function requireSkillName(raw: unknown): string {
  const name = requireString(raw, 'name');
  if (!isValidSkillName(name)) {
    throwIpcError('INVALID_PARAMS', `invalid skill name: ${name}`);
  }
  return name;
}

/** A non-empty array of known agent ids. */
function requireAgentIds(raw: unknown): AgentId[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throwIpcError('INVALID_PARAMS', 'agentIds must be a non-empty array');
  }
  return raw.map((v, i) => requireEnum(v, AGENT_IDS, `agentIds[${i}]`));
}

export function registerSkillsIpc(
  registry: IpcHandlerRegistry,
  store: SkillsStore,
  deps: SkillsIpcDeps,
): void {
  registry.register(IPC_CHANNELS.skillsGet, (_payload, meta) => {
    meta.assertTrustedSender();
    return store.snapshot();
  });

  registry.register(IPC_CHANNELS.skillsPull, (payload, meta) => {
    meta.assertTrustedSender();
    const obj = requireObject(payload);
    const agentId = requireEnum(obj.agentId, AGENT_IDS, 'agentId');
    const name = requireSkillName(obj.name);
    store.pull(agentId, name);
    return store.snapshot();
  });

  registry.register(IPC_CHANNELS.skillsPush, (payload, meta) => {
    meta.assertTrustedSender();
    const obj = requireObject(payload);
    const name = requireSkillName(obj.name);
    const agentIds = requireAgentIds(obj.agentIds);
    for (const agentId of agentIds) store.push(name, agentId);
    return store.snapshot();
  });

  registry.register(IPC_CHANNELS.skillsImport, async (_payload, meta) => {
    meta.assertTrustedSender();
    // The source path is chosen in MAIN — never supplied by the renderer.
    const src = await deps.pickImportDir();
    if (src === null) return { snapshot: store.snapshot(), imported: null };
    const imported = store.importFromDir(src);
    return { snapshot: store.snapshot(), imported };
  });

  registry.register(IPC_CHANNELS.skillsDelete, (payload, meta) => {
    meta.assertTrustedSender();
    const obj = requireObject(payload);
    store.deleteCentral(requireSkillName(obj.name));
    return store.snapshot();
  });

  registry.register(IPC_CHANNELS.skillsDiff, (payload, meta) => {
    meta.assertTrustedSender();
    const obj = requireObject(payload);
    const agentId = requireEnum(obj.agentId, AGENT_IDS, 'agentId');
    const name = requireSkillName(obj.name);
    return store.diff(agentId, name);
  });

  registry.register(IPC_CHANNELS.skillsFileContent, (payload, meta) => {
    meta.assertTrustedSender();
    const obj = requireObject(payload);
    const agentId = requireEnum(obj.agentId, AGENT_IDS, 'agentId');
    const name = requireSkillName(obj.name);
    const side = requireEnum(obj.side, ['central', 'agent'] as const, 'side');
    const relPath = requireString(obj.relPath, 'relPath');
    // The store accepts relPath ONLY if it names a file in the diff it computes itself.
    return store.fileContent(agentId, name, side, relPath);
  });

  registry.register(IPC_CHANNELS.skillsMerge, (payload, meta) => {
    meta.assertTrustedSender();
    const obj = requireObject(payload);
    const agentId = requireEnum(obj.agentId, AGENT_IDS, 'agentId');
    const name = requireSkillName(obj.name);
    if (!Array.isArray(obj.agentPicks)) {
      throwIpcError('INVALID_PARAMS', 'agentPicks must be an array');
    }
    const agentPicks = obj.agentPicks.map((v, i) => requireString(v, `agentPicks[${i}]`));
    // The store overwrites the CENTRAL copy atomically; it filters picks against its own diff.
    store.merge(agentId, name, agentPicks);
    return store.snapshot();
  });

  registry.register(IPC_CHANNELS.skillsReveal, async (payload, meta) => {
    meta.assertTrustedSender();
    const obj = requireObject(payload);
    const scope = requireEnum(obj.scope, ['central', 'agent'] as const, 'scope');
    const ref: { scope: 'central' | 'agent'; agentId?: AgentId; name?: string } = { scope };
    if (obj.agentId !== undefined) ref.agentId = requireEnum(obj.agentId, AGENT_IDS, 'agentId');
    if (obj.name !== undefined) ref.name = requireSkillName(obj.name);
    // The store resolves the ref to a CONTAINED directory from its own base dirs; a target that
    // isn't the central library or a known agent skills dir throws before we open anything.
    const dir = store.resolveRevealDir(ref);
    await deps.openPath(dir);
    return {};
  });
}
