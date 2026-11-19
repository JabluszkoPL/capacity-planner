/**
 * The MCP server's settings: on or off, whether changes are allowed, and the
 * bearer token clients must send.
 *
 * Kept by the main process in its own file next to the database, not in
 * AppState: these belong to this Mac, never sync, never go into an export, and
 * the token in particular must not leave the device the way a synced row does.
 * The file is written owner-only (0600) so another account on the same Mac
 * cannot read the token and drive the plan.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

export const DEFAULT_MCP_PORT = 5192;

export interface McpSettings {
  /** The endpoint listens at all. Off until the user turns it on. */
  enabled: boolean;
  /** Write tools are listed and run. Off until the user turns it on. */
  allowWrites: boolean;
  /** Bearer token every request must carry. */
  token: string;
  port: number;
}

/** 32 random bytes, URL-safe: fits a header and a shell command unquoted. */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

function isToken(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9_-]{32,}$/.test(v);
}

/**
 * Anything read from disk, made safe. A missing or mangled field takes its
 * default; a missing token gets a fresh one. Both switches default to off.
 */
export function normalizeMcpSettings(
  raw: unknown,
  makeToken: () => string = generateToken,
): McpSettings {
  const r =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>)
      : {};
  const port = Number(r.port);
  return {
    enabled: r.enabled === true,
    allowWrites: r.allowWrites === true,
    token: isToken(r.token) ? r.token : makeToken(),
    port:
      Number.isInteger(port) && port > 0 && port < 65536
        ? port
        : DEFAULT_MCP_PORT,
  };
}

export function loadMcpSettings(file: string): McpSettings {
  let raw: unknown = null;
  try {
    if (existsSync(file)) raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // Unreadable: start from defaults (off), with a new token.
  }
  const settings = normalizeMcpSettings(raw);
  if (!raw || (raw as { token?: unknown }).token !== settings.token) {
    saveMcpSettings(file, settings);
  }
  return settings;
}

export function saveMcpSettings(file: string, settings: McpSettings): void {
  try {
    writeFileSync(file, JSON.stringify(settings, null, 2), { mode: 0o600 });
    // `mode` only applies when the file is created; tighten an older one.
    chmodSync(file, 0o600);
  } catch (err) {
    console.warn("[planner] could not save MCP settings:", err);
  }
}
