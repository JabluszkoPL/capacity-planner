/**
 * Who may talk to the MCP endpoint.
 *
 * The endpoint can read every plan and, with changes allowed, rewrite them, so
 * the rules are stricter than the sync server's (apps/server/src/access.ts),
 * which has to let the app's own web page in. Nothing here is for a browser:
 *
 *  - **Path**: `/mcp` only.
 *  - **Host**: a loopback name or address. Defeats DNS rebinding, where a
 *    site re-points its own hostname at 127.0.0.1 to look same-origin.
 *  - **No browser at all**: any `Origin` header is refused. A browser sends
 *    one with every POST, from any page, while MCP clients (Claude Code,
 *    Codex, editors) send none. (`Sec-Fetch-*` is no signal: Node's own
 *    `fetch`, which those clients use, sends `Sec-Fetch-Mode: cors` too.)
 *  - **Bearer token**: random, per Mac, compared in constant time. This is
 *    what keeps out other programs and other accounts on the same machine,
 *    which can open a loopback socket as easily as the user can.
 *  - **POST** only: this server never streams, so GET has nothing to offer.
 *
 * Kept free of Electron and of the HTTP server so it can be tested alone.
 */
import { createHash, timingSafeEqual } from "node:crypto";

export const MCP_PATH = "/mcp";

export interface GuardRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
}

export type GuardResult =
  | { ok: true }
  | {
      ok: false;
      status: number;
      message: string;
      headers?: Record<string, string>;
    };

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function header(req: GuardRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function hostnameOf(host: string): string {
  const h = host.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end > 0 ? h.slice(0, end + 1) : h;
  }
  const colon = h.lastIndexOf(":");
  return colon > 0 ? h.slice(0, colon) : h;
}

export function isLoopbackHost(host: string | undefined): boolean {
  return host !== undefined && LOOPBACK_HOSTS.has(hostnameOf(host));
}

/** Equal-length digests, so the comparison takes the same time either way. */
export function tokenMatches(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b) && expected.length > 0;
}

function bearer(req: GuardRequest): string | null {
  const auth = header(req, "authorization");
  if (!auth) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(auth);
  return m ? m[1] : null;
}

export function checkMcpRequest(req: GuardRequest, token: string): GuardResult {
  const path = (req.url ?? "").split("?")[0];
  if (path !== MCP_PATH) {
    return { ok: false, status: 404, message: "Not found." };
  }
  if (!isLoopbackHost(header(req, "host"))) {
    return { ok: false, status: 403, message: "Forbidden host." };
  }
  if (header(req, "origin") !== undefined) {
    return {
      ok: false,
      status: 403,
      message: "Browsers may not use this endpoint.",
    };
  }
  const presented = bearer(req);
  if (presented === null || !tokenMatches(presented, token)) {
    return {
      ok: false,
      status: 401,
      message:
        "Missing or wrong token. Copy the install command again from Planner: About → AI assistants.",
    };
  }
  if (req.method !== "POST") {
    return {
      ok: false,
      status: 405,
      message: "Only POST is supported.",
      headers: { allow: "POST" },
    };
  }
  return { ok: true };
}
