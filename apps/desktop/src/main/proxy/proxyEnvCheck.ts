// Does the environment route our own loopback proxy through an HTTP proxy? (pure)
//
// A proxied agent talks to `http://127.0.0.1:<port>/<token>`. Many agent CLIs honor the
// standard proxy variables and do NOT exempt loopback on their own, so with `HTTPS_PROXY`
// (or `HTTP_PROXY` / `ALL_PROXY`) set and 127.0.0.1 missing from `NO_PROXY`, the request goes
// to the corporate / VPN proxy, which cannot reach the user's loopback — the agent fails with
// an opaque connection error. Agents launched from the same environment inherit it, so
// checking AiOpt's own environment is a good proxy for theirs.
//
// Diagnose only: the user's environment is never modified, and neither the proxy URL nor the
// variable values are logged or sent to the renderer — only the boolean verdict.

import { bypassedByNoProxy } from '../upstreams/http2Proxy';

const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'] as const;

/** True when a proxy variable is set and 127.0.0.1 would not bypass it. */
export function loopbackNotExemptFromProxy(env: Readonly<Record<string, string | undefined>>): boolean {
  if (!PROXY_VARS.some((name) => (env[name] ?? '').trim() !== '')) return false;
  const noProxy = [env.NO_PROXY, env.no_proxy].filter((v): v is string => typeof v === 'string').join(',');
  if (bypassedByNoProxy('127.0.0.1', noProxy)) return false;
  // A CIDR / wildcard spelling of loopback (127.0.0.0/8, 127.*) also exempts it.
  return !noProxy.split(/[,\s]+/).some((e) => /^127\./.test(e.trim()));
}
