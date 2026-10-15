// Agent sessions IPC — read-only access to agent session logs.
//
// Authorize the sender FIRST, then validate. The renderer names a session only by
// (agentId ∈ SESSION_AGENT_IDS, sessionId matching the id shape); main resolves the file
// from its own scan index. The two boundary-crossing effects stay main-side and are
// injected: copying the resume command writes to the OS clipboard, and export writes the
// Markdown to a path the user picks in a main-side save dialog. Neither path nor command
// is ever supplied by the renderer.

import type { IpcHandlerRegistry } from '../ipc/registry';
import { requireEnum, requireNonNegativeInt, requireObject, requireString, throwIpcError } from '../ipc/validate';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import {
  SESSION_AGENT_IDS,
  isSessionId,
  resumeCommand,
  transcriptToMarkdown,
  type SessionPackResult,
  type SessionRef,
} from '../../shared/agentSessions';
import { buildContextPack, normalizePackIndexes } from '../../shared/sessionContextPack';
import { TRANSCRIPT_ENTRIES_MAX } from './agentSessionStore';
import type { AgentSessionStore } from './agentSessionStore';
import { logger } from '../logger';

const log = logger.child('sessions');

export interface SessionsIpcDeps {
  writeClipboard: (text: string) => void;
  /** Main-side save dialog; resolves to the chosen path or null when cancelled. */
  pickSavePath: (defaultName: string) => Promise<string | null>;
  writeFile: (file: string, text: string) => Promise<void>;
  platform: string;
}

function requireRef(payload: unknown): SessionRef {
  const obj = requireObject(payload);
  const agentId = requireEnum(obj.agentId, SESSION_AGENT_IDS, 'agentId');
  const sessionId = requireString(obj.sessionId, 'sessionId');
  if (!isSessionId(sessionId)) throwIpcError('INVALID_PARAMS', 'invalid sessionId');
  return { agentId, sessionId };
}

interface PackRequest {
  ref: SessionRef;
  indexes: unknown[];
  total: number;
  firstTs: number;
}

function requirePackRequest(payload: unknown): PackRequest {
  const ref = requireRef(payload);
  const obj = payload as Record<string, unknown>;
  if (!Array.isArray(obj.indexes) || obj.indexes.length === 0 || obj.indexes.length > TRANSCRIPT_ENTRIES_MAX) {
    throwIpcError('INVALID_PARAMS', 'indexes must be a non-empty array');
  }
  const total = requireNonNegativeInt(obj.total, 'total');
  if (typeof obj.firstTs !== 'number' || !Number.isFinite(obj.firstTs)) throwIpcError('INVALID_PARAMS', 'invalid firstTs');
  return { ref, indexes: obj.indexes, total, firstTs: obj.firstTs };
}

function requireRefresh(payload: unknown): boolean {
  if (payload === undefined || payload === null) return false;
  const obj = requireObject(payload);
  if (obj.refresh !== undefined && typeof obj.refresh !== 'boolean') {
    throwIpcError('INVALID_PARAMS', 'refresh must be a boolean');
  }
  return obj.refresh === true;
}

export function registerSessionsIpc(
  registry: IpcHandlerRegistry,
  store: AgentSessionStore,
  deps: SessionsIpcDeps,
): void {
  registry.register(IPC_CHANNELS.sessionsList, (payload, meta) => {
    meta.assertTrustedSender();
    return store.sessions({ refresh: requireRefresh(payload) });
  });

  registry.register(IPC_CHANNELS.sessionsLocalUsage, (payload, meta) => {
    meta.assertTrustedSender();
    return store.localUsage({ refresh: requireRefresh(payload) });
  });

  registry.register(IPC_CHANNELS.sessionsTranscript, (payload, meta) => {
    meta.assertTrustedSender();
    return store.transcript(requireRef(payload));
  });

  registry.register(IPC_CHANNELS.sessionsCopyResume, async (payload, meta) => {
    meta.assertTrustedSender();
    const ref = requireRef(payload);
    const session = await store.find(ref);
    deps.writeClipboard(resumeCommand(ref, session.cwd, deps.platform));
    return {};
  });

  /** Re-read the transcript and pick the requested entries; refuse when it moved since. */
  async function packFor(req: PackRequest) {
    const transcript = await store.transcript(req.ref);
    const firstTs = transcript.entries[0]?.ts ?? 0;
    if (transcript.entries.length !== req.total || firstTs !== req.firstTs) {
      throwIpcError('PRECONDITION_FAILED', 'session changed; reload it');
    }
    const indexes = normalizePackIndexes(req.indexes, transcript.entries.length);
    if (!indexes) throwIpcError('INVALID_PARAMS', 'invalid indexes');
    return buildContextPack(transcript, indexes);
  }

  registry.register(IPC_CHANNELS.sessionsCopyPack, async (payload, meta): Promise<SessionPackResult> => {
    meta.assertTrustedSender();
    const req = requirePackRequest(payload);
    const pack = await packFor(req);
    deps.writeClipboard(pack.markdown);
    log.info('sessions.pack_copied', { agentId: req.ref.agentId, entries: pack.included });
    return { saved: true, included: pack.included, cut: pack.cut };
  });

  registry.register(IPC_CHANNELS.sessionsExportPack, async (payload, meta): Promise<SessionPackResult> => {
    meta.assertTrustedSender();
    const req = requirePackRequest(payload);
    const pack = await packFor(req);
    const file = await deps.pickSavePath(`${req.ref.agentId}-${req.ref.sessionId}-context.md`);
    if (!file) return { saved: false, included: pack.included, cut: pack.cut };
    await deps.writeFile(file, pack.markdown);
    log.info('sessions.pack_exported', { agentId: req.ref.agentId, entries: pack.included });
    return { saved: true, included: pack.included, cut: pack.cut };
  });

  registry.register(IPC_CHANNELS.sessionsExport, async (payload, meta) => {
    meta.assertTrustedSender();
    const ref = requireRef(payload);
    const transcript = await store.transcript(ref);
    const file = await deps.pickSavePath(`${ref.agentId}-${ref.sessionId}.md`);
    if (!file) return { saved: false };
    await deps.writeFile(file, transcriptToMarkdown(transcript));
    log.info('sessions.exported', { agentId: ref.agentId, entries: transcript.entries.length });
    return { saved: true };
  });
}
