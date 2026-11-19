/**
 * Who may talk to this server from a browser.
 *
 * The server has no accounts, and a WebSocket is not covered by CORS — any web
 * page the user happens to have open can try `new WebSocket("ws://localhost:
 * 5191/ws")`. Now that the Mac app runs this server whenever it is open, that
 * would let an unrelated site read and rewrite every plan. So browser requests
 * are held to two rules:
 *
 *  - **Host**: the request must be addressed to a loopback name, an IP
 *    literal, or a host the operator listed. This defeats DNS rebinding, where
 *    `evil.example` is re-pointed at 127.0.0.1 so that it looks same-origin.
 *  - **Origin** (when a browser sends one): it must be loopback, the app's own
 *    origin (same host and port as the request), the packaged Mac app
 *    (`file://`), or listed.
 *
 * Clients that send no Origin (Node, the test suite, curl) are not browsers
 * and are not what this guards against.
 */

export interface AccessOptions {
  /** Extra hostnames (and `host:port` origins) the operator trusts, e.g. a
   *  team deployment at planner.example.com. From PLANNER_ALLOWED_HOSTS. */
  allowedHosts: string[];
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function hostnameOf(hostHeader: string): string {
  // "[::1]:5191" -> "[::1]", "localhost:5191" -> "localhost"
  if (hostHeader.startsWith("[")) {
    const end = hostHeader.indexOf("]");
    return end > 0 ? hostHeader.slice(0, end + 1) : hostHeader;
  }
  const colon = hostHeader.lastIndexOf(":");
  return (colon > 0 ? hostHeader.slice(0, colon) : hostHeader).toLowerCase();
}

function isIpLiteral(hostname: string): boolean {
  return (
    /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) ||
    (hostname.startsWith("[") && hostname.endsWith("]"))
  );
}

function isLoopbackName(hostname: string): boolean {
  return LOOPBACK.has(hostname) || hostname.endsWith(".localhost");
}

export function isAllowedHost(
  hostHeader: string | undefined,
  options: AccessOptions,
): boolean {
  if (!hostHeader) return true; // HTTP/1.0 or a raw client; not a browser.
  const hostname = hostnameOf(hostHeader.trim());
  return (
    isLoopbackName(hostname) ||
    isIpLiteral(hostname) ||
    options.allowedHosts.includes(hostname)
  );
}

export function isAllowedOrigin(
  origin: string | undefined,
  hostHeader: string | undefined,
  options: AccessOptions,
): boolean {
  if (origin === undefined) return true;
  // The packaged Mac app loads from disk.
  if (origin === "file://" || origin === "null") return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const hostname = url.hostname.toLowerCase();
  const bracketed = hostname.includes(":") ? `[${hostname}]` : hostname;
  if (isLoopbackName(hostname) || isLoopbackName(bracketed)) return true;
  if (options.allowedHosts.includes(hostname)) return true;
  // The app this server itself served, reached by IP from another machine.
  return (
    hostHeader !== undefined &&
    url.host.toLowerCase() === hostHeader.trim().toLowerCase() &&
    isAllowedHost(hostHeader, options)
  );
}

export function accessOptionsFromEnv(
  env: Record<string, string | undefined> = process.env,
): AccessOptions {
  return {
    allowedHosts: (env.PLANNER_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  };
}
