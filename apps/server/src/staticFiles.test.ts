/**
 * The web app served by the sync server, and the access guard in front of
 * everything — exercised over a real socket, since both are about what a
 * browser actually sends.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import WebSocket from "ws";
import { migrate, type SqliteDriver } from "@planner/db";
import { openNodeDatabase } from "@planner/db/node";
import { listen, type RunningServer } from "./server";
import { resolveInside, rewriteIndexHtml, SYNC_META } from "./staticFiles";

let db: SqliteDriver;
let server: RunningServer;
let webDir: string;
let base: string;

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "planner-web-"));
  writeFileSync(
    join(webDir, "index.html"),
    '<!doctype html><html><head><script src="./assets/app.js"></script></head><body></body></html>',
  );
  mkdirSync(join(webDir, "assets"));
  writeFileSync(join(webDir, "assets", "app.js"), "console.log(1)");
  db = openNodeDatabase(":memory:");
  migrate(db);
  server = await listen(db, randomUUID(), 0, "127.0.0.1", {
    webDir,
    access: { allowedHosts: [] },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
  db.close();
  rmSync(webDir, { recursive: true, force: true });
});

/** fetch() won't let a test set Host or Origin freely; node:http will. */
function get(
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: server.port, path, headers },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("serving the web app", () => {
  it("serves index.html with a base href and the same-origin sync marker", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(res.body).toContain('<base href="/">');
    expect(res.body).toContain(SYNC_META);
  });

  it("serves the app shell for client routes", async () => {
    const res = await get("/project/abc");
    expect(res.status).toBe(200);
    expect(res.body).toContain(SYNC_META);
  });

  it("serves assets with a long cache and 404s missing ones", async () => {
    const hit = await get("/assets/app.js");
    expect(hit.body).toBe("console.log(1)");
    expect(hit.headers["cache-control"]).toContain("immutable");
    expect((await get("/assets/missing.js")).status).toBe(404);
  });

  it("refuses to leave the web directory", async () => {
    expect(resolveInside("/srv/web", "/../etc/passwd")).toBeNull();
    expect(resolveInside("/srv/web", "/%2e%2e/etc/passwd")).toBeNull();
    expect(resolveInside("/srv/web", "/assets/a.js")).toBe(
      "/srv/web/assets/a.js",
    );
    const res = await get("/%2e%2e/%2e%2e/etc/passwd");
    expect(res.status).toBe(400);
  });

  it("still answers the API", async () => {
    const res = await get("/health");
    expect(JSON.parse(res.body)).toMatchObject({ app: "planner", web: true });
  });

  it("injects into a head with attributes", () => {
    expect(rewriteIndexHtml('<head lang="en"><title>x</title>')).toBe(
      `<head lang="en"><base href="/">${SYNC_META}<title>x</title>`,
    );
  });
});

describe("access guard", () => {
  it("refuses a request addressed to a rebinding hostname", async () => {
    const res = await get("/api/state", {
      host: `evil.example:${server.port}`,
    });
    expect(res.status).toBe(403);
  });

  it("refuses another website's origin", async () => {
    const res = await get("/api/state", { origin: "https://evil.example" });
    expect(res.status).toBe(403);
  });

  it("does not offer the state dump to other origins via CORS", async () => {
    const res = await get("/api/state");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  function openSocket(origin?: string): Promise<"open" | "refused"> {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
        headers: origin ? { origin } : {},
      });
      ws.on("open", () => {
        ws.close();
        resolve("open");
      });
      ws.on("error", () => resolve("refused"));
    });
  }

  it("lets the app's own pages open the sync socket", async () => {
    await expect(openSocket(base)).resolves.toBe("open");
    await expect(openSocket("http://localhost:5190")).resolves.toBe("open");
    await expect(openSocket("file://")).resolves.toBe("open");
    await expect(openSocket()).resolves.toBe("open");
  });

  it("refuses the sync socket to another website", async () => {
    await expect(openSocket("https://evil.example")).resolves.toBe("refused");
  });
});
