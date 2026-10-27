/**
 * Web/PWA bridge. Only active when WEB_HEADLESS=1 — desktop mode is a no-op.
 *
 * Runs the real main process without a visible window and exposes its IPC
 * handlers over plain HTTP so a browser (the PWA) can drive the same code:
 *   POST /api/<channel>        ipcMain.handle(channel)  → JSON result
 *   POST /api/send/<channel>   ipcMain.on(channel)      → fire-and-forget
 *   POST /api/sync/<channel>   ipcMain.on(channel)      → evt.returnValue
 *   GET  /events               Server-Sent Events: webContents.send → browser
 *
 * Security: bound to 127.0.0.1, and every request must come from a localhost
 * origin and carry X-CTH-Bridge (a custom header, so cross-site pages cannot
 * send it without a CORS preflight that we refuse). This bridge exposes shell,
 * pty and filesystem access — do not widen it without auth.
 */
import { app, ipcMain, type BrowserWindow, type WebContents } from 'electron';
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';

export const WEB_HEADLESS = process.env.WEB_HEADLESS === '1';

type Handler = (evt: WebEvent, ...args: unknown[]) => unknown;
interface WebEvent { sender: WebContents | null; returnValue?: unknown; reply: () => void }

const invokeHandlers = new Map<string, Handler>();
const onHandlers = new Map<string, Handler>();
const sseClients = new Set<http.ServerResponse>();
let primary: WebContents | null = null;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon'
};

if (WEB_HEADLESS) {
  // Capture handler registrations. This module is imported first by the main
  // entry, so the patch lands before any other module registers its IPC.
  const ipc = ipcMain as unknown as {
    handle: (channel: string, fn: Handler) => void;
    on: (channel: string, fn: Handler) => void;
  };
  ipc.handle = (channel, fn) => { invokeHandlers.set(channel, fn); };
  ipc.on = (channel, fn) => { onHandlers.set(channel, fn); };
}

function broadcast(channel: string, args: unknown[]): void {
  const line = `data: ${JSON.stringify({ channel, args })}\n\n`;
  for (const res of sseClients) res.write(line);
}

/** Called from createWindow(): route this window's sends to the browser and
 *  keep it invisible. The renderer it would load is the desktop UI, which the
 *  browser provides instead. */
export function attachWebWindow(win: BrowserWindow): void {
  if (!WEB_HEADLESS) return;
  const wc = win.webContents;
  wc.send = (channel: string, ...args: unknown[]) => { broadcast(channel, args); };
  win.loadURL = async () => undefined;
  win.loadFile = async () => undefined;
  win.show = () => undefined;
  primary = wc;
  if (process.platform === 'darwin') app.dock?.hide();
}

function readBody(req: http.IncomingMessage): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c: Buffer) => { raw += c.toString('utf8'); if (raw.length > 50_000_000) req.destroy(); });
    req.on('end', () => {
      try {
        const parsed = raw ? JSON.parse(raw) : [];
        resolve(Array.isArray(parsed) ? parsed : []);
      } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function isAllowedOrigin(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // same-origin GETs and non-browser tools
  try {
    const { host } = new URL(origin);
    // Same origin as the page being served (e.g. http://<lan-ip>:3900), or loopback.
    return host === req.headers.host || host.startsWith('localhost:') || host.startsWith('127.0.0.1:')
      || host === 'localhost' || host === '127.0.0.1';
  } catch { return false; }
}

/** With WEB_TOKEN set, every /api and /events request needs the token cookie.
 *  The cookie is issued once by visiting /?token=<WEB_TOKEN>. EventSource and
 *  fetch send same-origin cookies automatically, so the browser shim needs no change. */
const WEB_TOKEN = process.env.WEB_TOKEN ?? '';
const COOKIE = 'cth_token';

function readCookie(req: http.IncomingMessage, name: string): string | undefined {
  const raw = req.headers.cookie ?? '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

function tokenOk(candidate: string | undefined): boolean {
  if (!WEB_TOKEN || !candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(WEB_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
  const dist = process.env.WEB_DIST ?? join(app.getAppPath(), 'web', 'dist');
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
  let file = normalize(join(dist, urlPath === '/' ? 'index.html' : urlPath));
  if (!file.startsWith(dist + sep) && file !== dist) { res.writeHead(403).end(); return; }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(dist, 'index.html');
  if (!existsSync(file)) { res.writeHead(404).end('web build missing: run npm run build:web'); return; }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: string): Promise<void> {
  if (req.method !== 'POST') { res.writeHead(405).end(); return; }
  if (req.headers['x-cth-bridge'] !== '1') { sendJson(res, 403, { error: 'missing X-CTH-Bridge header' }); return; }

  const sync = url.startsWith('/api/sync/');
  const fire = url.startsWith('/api/send/');
  const channel = decodeURIComponent(url.replace(/^\/api\/(sync|send)?\/?/, ''));
  const args = await readBody(req);
  const evt: WebEvent = { sender: primary, returnValue: undefined, reply: () => undefined };

  if (sync || fire) {
    const fn = onHandlers.get(channel);
    if (!fn) { sendJson(res, 404, { error: `no listener: ${channel}` }); return; }
    try {
      fn(evt, ...args);
      sendJson(res, 200, { result: evt.returnValue ?? null });
    } catch (err) { sendJson(res, 500, { error: String(err) }); }
    return;
  }

  const fn = invokeHandlers.get(channel);
  if (!fn) { sendJson(res, 404, { error: `no handler: ${channel}` }); return; }
  try {
    const result = await fn(evt, ...args);
    sendJson(res, 200, { result: result ?? null });
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

export function startWebBridge(): void {
  if (!WEB_HEADLESS) return;
  const port = Number(process.env.WEB_PORT ?? 3900);
  const host = process.env.WEB_HOST ?? '127.0.0.1';
  const loopback = host === '127.0.0.1' || host === 'localhost';

  // Refuse to expose shell/pty/fs access beyond loopback without a token.
  if (!loopback && !WEB_TOKEN) {
    console.error('[web-bridge] WEB_HOST is not loopback but WEB_TOKEN is empty — refusing to start.');
    app.exit(1);
    return;
  }

  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (!isAllowedOrigin(req)) { res.writeHead(403).end(); return; }

    // Token bootstrap: /?token=<WEB_TOKEN> sets the cookie, then redirects to the app.
    if (WEB_TOKEN && req.method === 'GET' && url.startsWith('/?token=')) {
      const given = decodeURIComponent(url.slice('/?token='.length));
      if (!tokenOk(given)) { res.writeHead(401).end('invalid token'); return; }
      res.writeHead(302, {
        'Set-Cookie': `${COOKIE}=${encodeURIComponent(WEB_TOKEN)}; HttpOnly; SameSite=Strict; Path=/`,
        Location: '/'
      });
      res.end();
      return;
    }

    const protectedRoute = url === '/events' || url.startsWith('/api/');
    if (WEB_TOKEN && protectedRoute && !tokenOk(readCookie(req, COOKIE))) {
      sendJson(res, 401, { error: 'unauthorized: open /?token=<WEB_TOKEN> first' });
      return;
    }

    if (url === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': connected\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    if (url.startsWith('/api/')) {
      handleApi(req, res, url).catch((err) => sendJson(res, 400, { error: String(err) }));
      return;
    }
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    serveStatic(req, res);
  });

  // Default loopback; Docker sets WEB_HOST=0.0.0.0 together with WEB_TOKEN.
  server.listen(port, host, () => {
    console.log(`[web-bridge] http://${host}:${port}${WEB_TOKEN ? ' (token required)' : ''}`);
  });
}

// Start once Electron is ready. Handlers are registered synchronously at module
// evaluation, so by the time a request arrives the core ones exist.
if (WEB_HEADLESS) void app.whenReady().then(startWebBridge);
