/**
 * HTTP + WebSocket transport around the Hub.
 *
 * The HTTP side exists for a few reasons only: a health check that tells a
 * client whether the server is reachable before it opens a socket, a read-only
 * state dump that makes the database inspectable while developing, the Jira
 * proxy, and — when given the web build — the app itself (./staticFiles). All
 * real data traffic is the WebSocket.
 *
 * Every browser request first passes ./access, which keeps other websites the
 * user has open from reaching any of it.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  PROTOCOL_VERSION,
  decodeClientMessage,
  encode,
  type ServerMessage,
} from "@planner/contracts";
import { readAppState, type SqliteDriver } from "@planner/db";
import { Hub, type Peer } from "./hub";
import {
  accessOptionsFromEnv,
  isAllowedHost,
  isAllowedOrigin,
  type AccessOptions,
} from "./access";
import { createStaticHandler } from "./staticFiles";
import {
  JIRA_PROXY_PREFIX,
  handleJiraProxy,
  jiraProxyOptions,
  jiraProxyPreflight,
} from "./jiraProxy";

/** Frames larger than this are refused — a planner state is tiny, and an
 *  unbounded frame is an easy way to exhaust memory. */
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

export interface RunningServer {
  http: Server;
  hub: Hub;
  port: number;
  close(): Promise<void>;
}

export interface SyncServerOptions {
  /** The web app's production build, served at `/` when set. */
  webDir?: string | null;
  access?: AccessOptions;
}

function isPermitted(req: IncomingMessage, access: AccessOptions): boolean {
  const origin = req.headers.origin;
  return (
    isAllowedHost(req.headers.host, access) &&
    isAllowedOrigin(
      typeof origin === "string" ? origin : undefined,
      req.headers.host,
      access,
    )
  );
}

export function createSyncServer(
  db: SqliteDriver,
  serverId: string,
  options: SyncServerOptions = {},
): { http: Server; hub: Hub; closeSockets: () => void } {
  const hub = new Hub(db, { serverId });
  const access = options.access ?? accessOptionsFromEnv();
  const serveStatic = options.webDir
    ? createStaticHandler(options.webDir)
    : null;
  // Tracked so shutdown can actually finish: `http.close()` waits for open
  // connections to drain, and a WebSocket never drains on its own.
  const sockets = new Set<WebSocket>();

  const jiraOptions = jiraProxyOptions();

  const http = createServer((req, res) => {
    const url = req.url ?? "/";
    if (!isPermitted(req, access)) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("forbidden");
      return;
    }
    if (url.startsWith(JIRA_PROXY_PREFIX)) {
      // Browsers cannot call Jira directly (no CORS there), so the app routes
      // through here. See ./jiraProxy for what is and isn't allowed.
      void handleJiraProxy(req, res, url, jiraOptions);
      return;
    }
    if (req.method === "OPTIONS") return jiraProxyPreflight(res);
    if (url === "/health") {
      return json(res, 200, {
        app: "planner",
        ok: true,
        serverId,
        protocol: PROTOCOL_VERSION,
        seq: hub.head(),
        connections: hub.connectionCount,
        // The web app asks before offering a Refresh button, so it can say
        // *why* refreshing is unavailable instead of failing on the attempt.
        jira: { proxy: true, writes: jiraOptions.allowWrites },
        web: serveStatic !== null,
      });
    }
    if (url === "/api/state") {
      // Read-only convenience for development. Writes only ever go over the
      // socket, so there is no mutating HTTP surface to secure. No CORS
      // header: the whole plan is not something another origin may read.
      return json(res, 200, readAppState(db), false);
    }
    if (serveStatic?.(req, res)) return;
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  const wss = new WebSocketServer({
    server: http,
    path: "/ws",
    maxPayload: MAX_FRAME_BYTES,
    // WebSockets are exempt from CORS, so this is the only thing standing
    // between another open tab and the user's data. See ./access.
    verifyClient: ({ req }: { req: IncomingMessage }) =>
      isPermitted(req, access),
  });

  let nextPeer = 0;
  wss.on("connection", (socket: WebSocket, req: IncomingMessage) => {
    const peerId = `peer-${++nextPeer}`;
    sockets.add(socket);
    const peer: Peer = {
      id: peerId,
      send(msg: ServerMessage) {
        if (socket.readyState === socket.OPEN) socket.send(encode(msg));
      },
    };
    hub.connect(peer);
    log(
      `+ ${peerId} from ${req.socket.remoteAddress ?? "?"} (${hub.connectionCount} connected)`,
    );

    socket.on("message", (raw) => {
      const msg = decodeClientMessage(raw.toString());
      if (!msg) {
        peer.send({
          t: "error",
          code: "bad_message",
          message: "Could not decode that frame.",
        });
        return;
      }
      try {
        hub.handle(peer, msg);
      } catch (err) {
        log(`! ${peerId} ${(err as Error).message}`);
        peer.send({ t: "error", code: "internal", message: "Server error." });
      }
    });

    socket.on("close", () => {
      sockets.delete(socket);
      hub.disconnect(peerId);
      log(`- ${peerId} (${hub.connectionCount} connected)`);
    });
    socket.on("error", () => {
      sockets.delete(socket);
      hub.disconnect(peerId);
    });
  });

  const closeSockets = () => {
    for (const socket of sockets) socket.terminate();
    sockets.clear();
  };

  return { http, hub, closeSockets };
}

export function listen(
  db: SqliteDriver,
  serverId: string,
  port: number,
  host: string,
  options: SyncServerOptions = {},
): Promise<RunningServer> {
  const { http, hub, closeSockets } = createSyncServer(db, serverId, options);
  return new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, host, () => {
      const addr = http.address();
      const actual = typeof addr === "object" && addr ? addr.port : port;
      resolve({
        http,
        hub,
        port: actual,
        close: () =>
          new Promise<void>((done) => {
            closeSockets();
            http.close(() => done());
          }),
      });
    });
  });
}

function json(
  res: import("node:http").ServerResponse,
  code: number,
  body: unknown,
  cors = true,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    // The web app is served from a different origin in dev.
    ...(cors ? { "access-control-allow-origin": "*" } : {}),
  });
  res.end(payload);
}

/** Connection logging is useful when running the server and noise in a test
 *  run that stands one up per case. */
const QUIET =
  process.env.VITEST !== undefined || process.env.PLANNER_QUIET === "1";

function log(line: string): void {
  if (!QUIET) console.log(`[sync] ${line}`);
}
