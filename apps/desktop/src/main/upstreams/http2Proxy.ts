// HTTP/2 over the user's proxy, for drivers that need `node:http2` (Electron's `net.fetch`
// honours the system proxy, but `node:http2` dials directly — behind a corporate proxy
// the chat stream then fails while unary calls work).
//
// The proxy is resolved per connection: Electron's `session.resolveProxy` first (system /
// PAC settings, injected so this module stays Electron-free), then the HTTPS_PROXY /
// ALL_PROXY environment variables (respecting NO_PROXY). An HTTP(S) proxy is used through
// a CONNECT tunnel; TLS to the real origin runs INSIDE the tunnel, so the proxy sees only
// the host name. SOCKS is not supported here and falls back to a direct connection.
//
// Proxy credentials (from a `user:pass@` env URL) are sent only as Proxy-Authorization to
// the proxy itself. Nothing here logs the proxy URL, credentials, or a proxy's reply.

import http2 from 'node:http2';
import net from 'node:net';
import tls from 'node:tls';

export interface ProxyEndpoint {
  protocol: 'http' | 'https';
  host: string;
  port: number;
  /** `user:pass` already percent-decoded, for Proxy-Authorization. */
  auth?: string;
}

/**
 * The first usable entry of a Chromium proxy-rule string ("PROXY h:p; DIRECT"). DIRECT
 * (or a SOCKS-only list) means no proxy — null.
 */
export function parseProxyRules(rules: string): ProxyEndpoint | null {
  for (const raw of rules.split(';')) {
    const entry = raw.trim();
    if (entry === '') continue;
    const [kind, hostPort] = entry.split(/\s+/, 2);
    const k = (kind ?? '').toUpperCase();
    if (k === 'DIRECT') return null;
    if ((k === 'PROXY' || k === 'HTTPS') && hostPort) {
      const ep = hostPortOf(hostPort, k === 'HTTPS' ? 443 : 80);
      if (ep) return { protocol: k === 'HTTPS' ? 'https' : 'http', ...ep };
    }
    // SOCKS / unknown: try the next entry.
  }
  return null;
}

function hostPortOf(hostPort: string, defaultPort: number): { host: string; port: number } | null {
  const m = /^\[?([^\]]+?)\]?(?::(\d+))?$/.exec(hostPort.trim());
  if (!m?.[1]) return null;
  const port = m[2] ? Number(m[2]) : defaultPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: m[1], port };
}

/** Whether NO_PROXY excludes `host` (comma list; `*`, exact, `.suffix` / `suffix`). */
export function bypassedByNoProxy(host: string, noProxy: string | undefined): boolean {
  if (!noProxy) return false;
  const h = host.toLowerCase();
  return noProxy
    .split(/[,\s]+/)
    .map((e) => e.trim().toLowerCase().replace(/:\d+$/, ''))
    .filter((e) => e !== '')
    .some((e) => e === '*' || h === e.replace(/^\./, '') || h.endsWith(e.startsWith('.') ? e : `.${e}`));
}

/** The proxy the environment names for an https target, or null. */
export function proxyFromEnv(host: string, env: Record<string, string | undefined>): ProxyEndpoint | null {
  if (bypassedByNoProxy(host, env.NO_PROXY ?? env.no_proxy)) return null;
  const raw = env.HTTPS_PROXY ?? env.https_proxy ?? env.ALL_PROXY ?? env.all_proxy;
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw.includes('://') ? raw : `http://${raw}`);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const https = u.protocol === 'https:';
  const port = u.port ? Number(u.port) : https ? 443 : 80;
  const auth = u.username ? `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}` : undefined;
  return {
    protocol: https ? 'https' : 'http',
    host: u.hostname.replace(/^\[|\]$/g, ''),
    port,
    ...(auth ? { auth } : {}),
  };
}

const TUNNEL_TIMEOUT_MS = 15_000;
const MAX_CONNECT_REPLY = 16 * 1024;

/** Open a CONNECT tunnel to `host:port` through `proxy`; resolves the raw tunnel socket. */
export function openTunnel(
  proxy: ProxyEndpoint,
  host: string,
  port: number,
  dial: { net: typeof net.connect; tls: typeof tls.connect } = {
    net: net.connect,
    tls: tls.connect,
  },
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock: net.Socket =
      proxy.protocol === 'https'
        ? dial.tls({
            host: proxy.host,
            port: proxy.port,
            servername: net.isIP(proxy.host) ? undefined : proxy.host,
          })
        : dial.net({ host: proxy.host, port: proxy.port });
    let buf = Buffer.alloc(0);
    let done = false;
    const fail = (reason: string): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      reject(new Error(reason));
    };
    const timer = setTimeout(() => fail('proxy tunnel timed out'), TUNNEL_TIMEOUT_MS);
    sock.once('error', () => fail('proxy unreachable'));
    sock.once('close', () => fail('proxy closed the tunnel'));
    const authority = `${net.isIPv6(host) ? `[${host}]` : host}:${port}`;
    const onReady = (): void => {
      const lines = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`];
      if (proxy.auth) lines.push(`Proxy-Authorization: Basic ${Buffer.from(proxy.auth).toString('base64')}`);
      sock.write(`${lines.join('\r\n')}\r\n\r\n`);
    };
    sock.once(proxy.protocol === 'https' ? 'secureConnect' : 'connect', onReady);
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end === -1) {
        if (buf.length > MAX_CONNECT_REPLY) fail('proxy reply too large');
        return;
      }
      sock.off('data', onData);
      // The proxy's reply text is never surfaced — only whether it said 2xx.
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(buf.subarray(0, end).toString('latin1'))?.[1];
      if (!status || !status.startsWith('2')) {
        fail(status === '407' ? 'proxy authentication required' : 'proxy refused the tunnel');
        return;
      }
      done = true;
      clearTimeout(timer);
      sock.removeAllListeners('error');
      sock.removeAllListeners('close');
      const rest = buf.subarray(end + 4);
      if (rest.length > 0) sock.unshift(rest);
      resolve(sock);
    };
    sock.on('data', onData);
  });
}

export interface ProxiedHttp2Deps {
  /** Electron's `session.resolveProxy` (a Chromium rule string); absent = env only. */
  resolveProxy?: (url: string) => Promise<string>;
  env?: Record<string, string | undefined>;
  /** Test seams. */
  http2Connect?: typeof http2.connect;
  tunnel?: typeof openTunnel;
}

/** Resolve the proxy for an https origin: system / PAC first, then the environment. */
export async function resolveProxyFor(origin: string, deps: ProxiedHttp2Deps): Promise<ProxyEndpoint | null> {
  const host = new URL(origin).hostname;
  if (deps.resolveProxy) {
    try {
      const fromSystem = parseProxyRules(await deps.resolveProxy(origin));
      if (fromSystem) return fromSystem;
    } catch {
      // Fall through to the environment.
    }
  }
  return proxyFromEnv(host, deps.env ?? {});
}

/**
 * An `http2.connect` that goes through the user's proxy when one applies, and dials
 * directly otherwise. Resolves once the session is created (the tunnel, when used, is up).
 */
export function createProxiedHttp2Connect(
  deps: ProxiedHttp2Deps,
): (authority: string) => Promise<http2.ClientHttp2Session> {
  const connect = deps.http2Connect ?? http2.connect;
  const tunnel = deps.tunnel ?? openTunnel;
  return async (authority) => {
    const u = new URL(authority);
    const proxy = await resolveProxyFor(u.origin, deps);
    if (!proxy) return connect(authority);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const port = u.port ? Number(u.port) : 443;
    const raw = await tunnel(proxy, host, port);
    return connect(authority, {
      createConnection: () =>
        tls.connect({
          socket: raw,
          servername: net.isIP(host) ? undefined : host,
          ALPNProtocols: ['h2'],
        }),
    });
  };
}
