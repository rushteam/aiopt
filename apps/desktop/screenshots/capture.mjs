// Capture the README screenshots: the real renderer, served by Vite, against the demo
// data in mockBridge.ts, photographed by headless Chrome at the app's window size.
//
//   pnpm --filter desktop screenshots          # writes docs/images/screenshots/*.png
//
// Dev-only. Touches no user data: there is no main process, and the bridge is a mock.
// Chrome is driven over the DevTools protocol (Node's built-in WebSocket, no extra
// dependency) so each capture waits for the screen to render instead of guessing a delay.
// CHROME overrides the browser path (default: Google Chrome on macOS).

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const outDir = path.resolve(appRoot, '../../docs/images/screenshots');
const chromePath =
  process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// Window size from main/window/mainWindow.ts; captured at 2x for Retina-sharp README images.
const WIDTH = 1024;
const HEIGHT = 720;
const SCALE = 2;

// `ready` is a script evaluated in the page; the capture waits until it is truthy.
const SHOTS = [
  { name: 'providers', query: { tab: 'providers' }, ready: 'document.querySelectorAll("[role=switch]").length > 0' },
  { name: 'usage', query: { tab: 'usage' }, ready: 'document.querySelectorAll("table").length > 0' },
  {
    name: 'skills',
    query: { tab: 'skills', select: 'code-review' },
    ready: 'document.body.innerText.includes("Push to all")',
  },
];
const THEMES = ['light', 'dark'];

const server = await createServer({
  configFile: path.join(appRoot, 'vite.renderer.config.ts'),
  root: appRoot,
  logLevel: 'warn',
  server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
});
await server.listen();
const origin = server.resolvedUrls.local[0].replace(/\/$/, '');

const profile = mkdtempSync(path.join(tmpdir(), 'aiopt-shots-'));
const chrome = spawn(
  chromePath,
  [
    '--headless',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

try {
  const cdp = await connect(await debuggerUrl(profile));
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const page = (method, params) => cdp.send(method, params, sessionId);

  await page('Emulation.setDeviceMetricsOverride', {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: SCALE,
    mobile: false,
  });

  mkdirSync(outDir, { recursive: true });
  for (const shot of SHOTS) {
    for (const theme of THEMES) {
      await page('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: theme }],
      });
      const query = new URLSearchParams({ ...shot.query, theme, lang: 'en' });
      await page('Page.navigate', { url: `${origin}/screenshots/index.html?${query}` });
      await waitFor(page, shot.ready, `${shot.name}-${theme}`);
      await sleep(300); // let fonts and the last layout pass settle
      const { data } = await page('Page.captureScreenshot', { format: 'png' });
      const file = path.join(outDir, `${shot.name}-${theme}.png`);
      writeFileSync(file, Buffer.from(data, 'base64'));
      console.log(path.relative(process.cwd(), file));
    }
  }
  cdp.close();
} finally {
  // Wait for Chrome to exit before removing its profile; it writes there until it does.
  const exited = new Promise((resolve) => chrome.once('exit', resolve));
  chrome.kill();
  await exited;
  await server.close();
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}

async function debuggerUrl(dir) {
  const file = path.join(dir, 'DevToolsActivePort');
  for (let i = 0; i < 200; i++) {
    if (existsSync(file)) {
      const [port, wsPath] = readFileSync(file, 'utf8').trim().split('\n');
      if (port && wsPath) return `ws://127.0.0.1:${port}${wsPath}`;
    }
    await sleep(100);
  }
  throw new Error('Chrome did not open a DevTools port');
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    let nextId = 1;
    ws.onerror = () => reject(new Error(`cannot connect to ${url}`));
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      const waiter = msg.id !== undefined && pending.get(msg.id);
      if (!waiter) return;
      pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(`${waiter.method}: ${msg.error.message}`));
      else waiter.resolve(msg.result);
    };
    ws.onopen = () =>
      resolve({
        send: (method, params = {}, sessionId) =>
          new Promise((res, rej) => {
            const id = nextId++;
            pending.set(id, { resolve: res, reject: rej, method });
            ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
          }),
        close: () => ws.close(),
      });
  });
}

async function waitFor(page, expression, label) {
  for (let i = 0; i < 150; i++) {
    const { result } = await page('Runtime.evaluate', { expression, returnByValue: true });
    if (result.value === true) return;
    await sleep(100);
  }
  throw new Error(`${label}: the screen never became ready (${expression})`);
}
