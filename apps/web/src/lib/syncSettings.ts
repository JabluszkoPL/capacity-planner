/**
 * Which sync server this browser uses, chosen in the app rather than at build
 * time.
 *
 * Per device, in localStorage, for the same reason as the Jira settings: it
 * describes this machine's setup, and AppState is replicated to every device.
 * It is only consulted in a browser — the Mac app decides its own server in
 * the main process (apps/desktop/electron/shareServer.ts).
 */

export const SYNC_URL_KEY = "planner_sync_url_v1";

export function readSyncUrlSetting(): string | null {
  try {
    const v = localStorage.getItem(SYNC_URL_KEY);
    return v && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

/** Store a server URL, or clear it with null. Returns false if unsaved. */
export function writeSyncUrlSetting(url: string | null): boolean {
  try {
    if (url && url.trim()) localStorage.setItem(SYNC_URL_KEY, url.trim());
    else localStorage.removeItem(SYNC_URL_KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * Turn what a person types into a WebSocket URL: "localhost:5191",
 * "http://192.168.1.20:5191" and "ws://host:5191/ws" all mean the same server.
 * Returns null when it isn't a usable address.
 */
export function normalizeSyncUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : `ws://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol !== "ws:" && url.protocol !== "wss:") return null;
  if (!url.hostname) return null;
  if (url.pathname === "/" || url.pathname === "") url.pathname = "/ws";
  url.hash = "";
  return url.toString();
}

/** True when this page was served by a Planner sync server (see
 *  apps/server/src/staticFiles.ts), which marks the page for same-origin sync. */
export function servedBySyncServer(): boolean {
  if (typeof document === "undefined") return false;
  const meta = document.querySelector('meta[name="planner-sync"]');
  return meta?.getAttribute("content") === "same-origin";
}

/** The sync socket on the server this page came from. */
export function sameOriginSyncUrl(): string {
  const { protocol, host } = window.location;
  return `${protocol === "https:" ? "wss:" : "ws:"}//${host}/ws`;
}
