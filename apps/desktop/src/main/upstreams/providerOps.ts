// The provider-manager operations every upstream driver gets for free: "Load models" and
// the connectivity test, answered through the driver instead of `GET /models`.
// Errors are coded and key-free; the upstream's own text stays main-side.

import type { ProviderFetchModelsResult, ProviderTestResult } from '../../shared/ipc-channels';
import { throwIpcError } from '../ipc/validate';
import { UpstreamError, upstreamErrorStatus, type BoundUpstream } from './types';

export async function fetchUpstreamModels(up: BoundUpstream): Promise<ProviderFetchModelsResult> {
  let models;
  try {
    models = await up.listModels();
  } catch (e) {
    if (e instanceof UpstreamError && e.noCredential) throwIpcError('UNAUTHORIZED', 'the sign-in is missing or expired');
    const status = upstreamErrorStatus(e);
    if (status === 401 || status === 403) throwIpcError('UNAUTHORIZED', 'the provider rejected the sign-in');
    throwIpcError('UPSTREAM_ERROR', 'could not list the provider models');
  }
  return { models, catalogSource: 'vendor' };
}

/** A cheap live check: the model list answers for this credential. */
export async function testUpstream(up: BoundUpstream): Promise<ProviderTestResult> {
  const started = Date.now();
  const fail = (error: ProviderTestResult['error']): ProviderTestResult => ({ ok: false, latencyMs: null, format: null, error });
  try {
    const models = await up.listModels();
    if (models.length === 0) return fail('no_models');
    return { ok: true, latencyMs: Date.now() - started, format: 'openai', error: null };
  } catch (e) {
    if (e instanceof UpstreamError && e.noCredential) return fail('no_key');
    const status = upstreamErrorStatus(e);
    if (status === 401 || status === 403) return fail('unauthorized');
    if (status === null || status === 502) return fail('unreachable');
    return fail('upstream');
  }
}
