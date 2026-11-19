/**
 * Serving the web app from the sync server.
 *
 * When the server is given the web build (PLANNER_WEB_DIR — the Mac app passes
 * its own renderer), opening the server's address in a browser loads Planner
 * itself, already connected to this server. That is what makes "the same data
 * in another browser" one URL rather than a setup guide.
 *
 * Two small rewrites of index.html make that work:
 *  - `<base href="/">`: the bundle uses relative asset URLs (it must, to load
 *    from `file://` in the Mac app), which would break on a deep link such as
 *    /project/abc without a base.
 *  - `<meta name="planner-sync" content="same-origin">`: tells the app to sync
 *    with the server it was loaded from. See apps/web/src/runtime.ts.
 */
import { readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

export const SYNC_META = '<meta name="planner-sync" content="same-origin">';

export function rewriteIndexHtml(html: string): string {
  const inject = `<base href="/">${SYNC_META}`;
  return /<head[^>]*>/i.test(html)
    ? html.replace(/<head[^>]*>/i, (m) => m + inject)
    : inject + html;
}

/**
 * Resolve a request path inside `root`, or null if it would escape it.
 * Exported for tests.
 */
export function resolveInside(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split("?")[0]!.split("#")[0]!);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const full = normalize(join(root, decoded));
  const base = normalize(root.endsWith(sep) ? root : root + sep);
  return full === normalize(root) || full.startsWith(base) ? full : null;
}

export function createStaticHandler(
  webDir: string,
): (req: IncomingMessage, res: ServerResponse) => boolean {
  let indexCache: string | null = null;
  const index = (): string => {
    indexCache ??= rewriteIndexHtml(
      readFileSync(join(webDir, "index.html"), "utf8"),
    );
    return indexCache;
  };

  /** Returns false when the request isn't a static GET this handler owns. */
  return (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    const urlPath = req.url ?? "/";
    const path = resolveInside(webDir, urlPath);
    if (path === null) {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("bad path");
      return true;
    }

    let file: string | null = null;
    try {
      if (statSync(path).isFile()) file = path;
    } catch {
      // not a file; fall through to the app shell
    }

    if (file && !file.endsWith(`${sep}index.html`)) {
      const body = readFileSync(file);
      res.writeHead(200, {
        "content-type": TYPES[extname(file)] ?? "application/octet-stream",
        "content-length": body.length,
        // Vite fingerprints everything under assets/; the shell is not.
        "cache-control": urlPath.startsWith("/assets/")
          ? "public, max-age=31536000, immutable"
          : "no-cache",
      });
      res.end(req.method === "HEAD" ? undefined : body);
      return true;
    }

    // A path with an extension that doesn't exist is a real 404 (a missing
    // asset should not quietly come back as HTML); anything else is a client
    // route like /project/abc and gets the app shell.
    if (extname(urlPath.split("?")[0]!) !== "") return false;
    const html = index();
    res.writeHead(200, {
      "content-type": TYPES[".html"]!,
      "content-length": Buffer.byteLength(html),
      "cache-control": "no-cache",
    });
    res.end(req.method === "HEAD" ? undefined : html);
    return true;
  };
}
