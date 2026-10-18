// CodeArts model list helpers — pure parse + signed remote fetch.

import type { ProviderModel } from '../../../shared/aiProviders';
import type { ProxyFetchResponse } from '../../proxy/upstream';
import {
  CODEARTS_BENEFIT_MODEL_FALLBACK,
  CODEARTS_FALLBACK_MODELS,
  CODEARTS_MODEL_BUILTIN_URL,
  CODEARTS_OPENGW_GATEWAY_CONFIG_URL,
} from './constants';
import type { CodeArtsSession } from './session';
import { signRequestHuawei } from './sign';

export type CodeArtsModelsFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<ProxyFetchResponse>;

/** Strip a trailing `-<digits>` date suffix from a model id. */
export function normalizeCodeArtsModelId(raw: string): string {
  return raw.replace(/-\d{4,}$/, '');
}

function prettify(id: string): string {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((p) => (p.length <= 3 ? p.toUpperCase() : p[0]!.toUpperCase() + p.slice(1)))
    .join(' ');
}

function isVisionModel(id: string): boolean {
  return id.includes('-VL-') || id.endsWith('-VL');
}

function extractArray(root: unknown, path: string[]): unknown[] | null {
  let cur: unknown = root;
  for (const key of path) {
    if (!cur || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[key];
  }
  return Array.isArray(cur) ? cur : null;
}

export function parseCodeArtsModelInfo(
  item: unknown,
  seen: Set<string>,
): ProviderModel | null {
  if (!item || typeof item !== 'object') return null;
  const rawId = (item as { model_id?: unknown }).model_id;
  if (typeof rawId !== 'string' || !rawId.trim()) return null;
  const id = normalizeCodeArtsModelId(rawId.trim());
  if (!id || isVisionModel(id) || seen.has(id)) return null;
  seen.add(id);
  const rawName = (item as { model_name?: unknown }).model_name;
  const name =
    typeof rawName === 'string' && rawName.trim()
      ? normalizeCodeArtsModelId(rawName.trim())
      : prettify(id);
  return { id, ...(name && name !== id ? { catalogName: name } : {}) };
}

export function createBenefitModelSet(initial: Iterable<string> = CODEARTS_BENEFIT_MODEL_FALLBACK): {
  has(model: string): boolean;
  remember(ids: Iterable<string>): void;
} {
  const set = new Set<string>([...initial]);
  return {
    has(model) {
      const id = String(model ?? '');
      return set.has(id) || (CODEARTS_BENEFIT_MODEL_FALLBACK as readonly string[]).includes(id);
    },
    remember(ids) {
      for (const id of ids) if (id) set.add(id);
    },
  };
}

async function signedGetText(
  session: CodeArtsSession,
  url: string,
  fetchImpl: CodeArtsModelsFetch,
  extraUnsigned?: Record<string, string>,
  signal?: AbortSignal,
): Promise<string | null> {
  const signed = signRequestHuawei({
    accessKeyId: session.accessKeyId,
    secretAccessKey: session.secretAccessKey,
    securityToken: session.securityToken,
    method: 'GET',
    url,
    body: '',
  });
  const headers = { ...signed, ...(extraUnsigned ?? {}) };
  try {
    const res = await fetchImpl(url, { method: 'GET', headers, signal });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/** Live model list (opengw benefit ∪ snap builtin). Updates `benefit` when gateway ids arrive. */
export async function fetchCodeArtsRemoteModels(
  session: CodeArtsSession,
  fetchImpl: CodeArtsModelsFetch,
  benefit: { remember(ids: Iterable<string>): void },
  signal?: AbortSignal,
): Promise<ProviderModel[]> {
  const models: ProviderModel[] = [];
  const seen = new Set<string>();
  const benefitIds: string[] = [];

  const gatewayText = await signedGetText(
    session,
    CODEARTS_OPENGW_GATEWAY_CONFIG_URL,
    fetchImpl,
    undefined,
    signal,
  );
  if (gatewayText) {
    let root: unknown;
    try {
      root = JSON.parse(gatewayText);
    } catch {
      root = null;
    }
    for (const item of extractArray(root, ['result', 'models']) ?? []) {
      const mi = parseCodeArtsModelInfo(item, seen);
      if (!mi) continue;
      const rawId =
        item && typeof item === 'object' && typeof (item as { model_id?: unknown }).model_id === 'string'
          ? String((item as { model_id: string }).model_id)
          : '';
      // Undated gateway ids are the benefit ids we actually send.
      if (rawId && rawId === mi.id) benefitIds.push(mi.id);
      models.push(mi);
    }
  }

  const snapText = await signedGetText(
    session,
    CODEARTS_MODEL_BUILTIN_URL,
    fetchImpl,
    {
      'Content-Type': 'application/json',
      'Agent-Type': 'PromptCenter',
      'X-Language': 'zh-cn',
    },
    signal,
  );
  if (snapText) {
    let root: unknown;
    try {
      root = JSON.parse(snapText);
    } catch {
      root = null;
    }
    for (const item of extractArray(root, ['builtinModels']) ?? []) {
      const mi = parseCodeArtsModelInfo(item, seen);
      if (mi) models.push(mi);
    }
  }

  if (benefitIds.length > 0) benefit.remember(benefitIds);
  return models;
}

export function codeArtsFallbackModels(): ProviderModel[] {
  return CODEARTS_FALLBACK_MODELS.map((m) => ({ ...m }));
}
