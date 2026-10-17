import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bypassedByNoProxy,
  createProxiedHttp2Connect,
  openTunnel,
  parseProxyRules,
  proxyFromEnv,
  resolveProxyFor,
} from '../http2Proxy';

describe('proxy resolution', () => {
  it('parses Chromium proxy rules', () => {
    expect(parseProxyRules('DIRECT')).toBeNull();
    expect(parseProxyRules('PROXY 10.0.0.1:3128; DIRECT')).toEqual({ protocol: 'http', host: '10.0.0.1', port: 3128 });
    expect(parseProxyRules('SOCKS5 s:1080; HTTPS p.corp:8443')).toEqual({ protocol: 'https', host: 'p.corp', port: 8443 });
    expect(parseProxyRules('SOCKS5 s:1080')).toBeNull();
  });

  it('reads HTTPS_PROXY with credentials and honours NO_PROXY', () => {
    expect(proxyFromEnv('api.test', { HTTPS_PROXY: 'http://u%40x:p@proxy:8080' })).toEqual({
      protocol: 'http',
      host: 'proxy',
      port: 8080,
      auth: 'u@x:p',
    });
    expect(proxyFromEnv('api.test', { https_proxy: 'proxy:3128', NO_PROXY: '.test' })).toBeNull();
    expect(proxyFromEnv('api.test', { ALL_PROXY: 'socks5://s:1080' })).toBeNull();
    expect(bypassedByNoProxy('a.cursor.sh', 'localhost, cursor.sh')).toBe(true);
    expect(bypassedByNoProxy('evilcursor.sh', 'cursor.sh')).toBe(false);
  });

  it('prefers the system resolver, then the environment', async () => {
    const env = { HTTPS_PROXY: 'http://envproxy:1' };
    expect(await resolveProxyFor('https://x.test', { resolveProxy: async () => 'PROXY sys:2', env })).toMatchObject({ host: 'sys' });
    expect(await resolveProxyFor('https://x.test', { resolveProxy: async () => 'DIRECT', env })).toMatchObject({ host: 'envproxy' });
    expect(await resolveProxyFor('https://x.test', { resolveProxy: async () => { throw new Error('x'); } })).toBeNull();
  });

  it('dials directly when no proxy applies', async () => {
    const seen: unknown[] = [];
    const connect = createProxiedHttp2Connect({
      resolveProxy: async () => 'DIRECT',
      http2Connect: ((authority: string, opts?: unknown) => {
        seen.push([authority, opts]);
        return {} as never;
      }) as never,
    });
    await connect('https://agent.test');
    expect(seen).toEqual([['https://agent.test', undefined]]);
  });
});

describe('CONNECT tunnel', () => {
  const servers: net.Server[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  });

  function fakeProxy(reply: string): Promise<{ port: number; requests: string[] }> {
    const requests: string[] = [];
    return new Promise((resolve) => {
      const srv = net.createServer((sock) => {
        sock.once('data', (d) => {
          requests.push(d.toString('latin1'));
          sock.write(reply);
          if (reply.startsWith('HTTP/1.1 200')) sock.on('data', (x) => sock.write(x)); // echo
          else sock.end();
        });
      });
      servers.push(srv);
      srv.listen(0, '127.0.0.1', () => resolve({ port: (srv.address() as net.AddressInfo).port, requests }));
    });
  }

  it('sends CONNECT with Proxy-Authorization and hands back the tunnel', async () => {
    const { port, requests } = await fakeProxy('HTTP/1.1 200 Connection established\r\n\r\n');
    const sock = await openTunnel({ protocol: 'http', host: '127.0.0.1', port, auth: 'u:p' }, 'agent.test', 443);
    expect(requests[0]).toContain('CONNECT agent.test:443 HTTP/1.1');
    expect(requests[0]).toContain(`Proxy-Authorization: Basic ${Buffer.from('u:p').toString('base64')}`);
    const echoed = await new Promise<string>((r) => {
      sock.once('data', (d) => r(d.toString()));
      sock.write('ping');
    });
    expect(echoed).toBe('ping');
    sock.destroy();
  });

  it('rejects on a non-2xx reply without surfacing the proxy text', async () => {
    const { port } = await fakeProxy('HTTP/1.1 407 Auth Required secret-realm\r\n\r\n');
    await expect(openTunnel({ protocol: 'http', host: '127.0.0.1', port }, 'agent.test', 443)).rejects.toThrow(
      /^proxy authentication required$/,
    );
  });
});
