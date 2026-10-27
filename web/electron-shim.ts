/**
 * Browser stand-in for the `electron` module. Vite aliases `electron` to this
 * file in web mode, so src/preload/index.ts runs unchanged and still exposes
 * `window.cth` with the exact same API. Transport: HTTP POST for invoke/sync
 * calls, Server-Sent Events for main → renderer events (see src/main/webBridge.ts).
 */

type Listener = (event: { sender: null }, ...args: unknown[]) => void;

const BRIDGE_HEADERS = { 'Content-Type': 'application/json', 'X-CTH-Bridge': '1' };
const listeners = new Map<string, Set<Listener>>();
let events: EventSource | null = null;

function ensureEvents(): void {
  if (events) return;
  events = new EventSource('/events');
  events.onmessage = (msg) => {
    try {
      const { channel, args } = JSON.parse(msg.data) as { channel: string; args: unknown[] };
      for (const fn of listeners.get(channel) ?? []) fn({ sender: null }, ...args);
    } catch { /* malformed event: drop it, never crash the renderer */ }
  };
}

async function invoke(channel: string, args: unknown[]): Promise<unknown> {
  const res = await fetch(`/api/${encodeURIComponent(channel)}`, {
    method: 'POST', headers: BRIDGE_HEADERS, body: JSON.stringify(args)
  });
  const body = (await res.json().catch(() => ({}))) as { result?: unknown; error?: string };
  if (!res.ok) throw new Error(`Error invoking remote method '${channel}': ${body.error ?? res.statusText}`);
  return body.result;
}

// Synchronous XHR is deprecated, but preload uses sendSync only for three
// startup reads (clipboard, roster, home dir), where the sync result is required.
function invokeSync(channel: string, args: unknown[]): unknown {
  const xhr = new XMLHttpRequest();
  xhr.open('POST', `/api/sync/${encodeURIComponent(channel)}`, false);
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.setRequestHeader('X-CTH-Bridge', '1');
  xhr.send(JSON.stringify(args));
  const body = JSON.parse(xhr.responseText || '{}') as { result?: unknown };
  return body.result;
}

export const contextBridge = {
  exposeInMainWorld(key: string, api: unknown): void {
    (window as unknown as Record<string, unknown>)[key] = api;
  }
};

export const ipcRenderer = {
  invoke: (channel: string, ...args: unknown[]) => invoke(channel, args),
  sendSync: (channel: string, ...args: unknown[]) => invokeSync(channel, args),
  on(channel: string, listener: Listener) {
    ensureEvents();
    let set = listeners.get(channel);
    if (!set) { set = new Set(); listeners.set(channel, set); }
    set.add(listener);
    return this;
  },
  removeListener(channel: string, listener: Listener) {
    listeners.get(channel)?.delete(listener);
    return this;
  }
};

// Browsers do not expose absolute file paths. Drag-and-drop still works; the
// path is empty, so anything that needs a real path is limited in web mode.
export const webUtils = {
  getPathForFile: (_file: File): string => ''
};
