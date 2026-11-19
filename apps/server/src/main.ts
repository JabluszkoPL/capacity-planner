/**
 * Entry point. Opens the database, migrates it, and starts listening.
 *
 * Run standalone (`pnpm dev:server`, or `pnpm serve` to include the web app)
 * to sync several machines against one box. The Mac app also bundles this
 * entry point and runs it as a child process on loopback, so a browser on the
 * same Mac sees the same data — see apps/desktop/electron/shareServer.ts.
 */
import { randomUUID } from "node:crypto";
import { migrate, getMeta, setMeta } from "@planner/db";
import { openNodeDatabase } from "@planner/db/node";
import { loadConfig } from "./config";
import { listen } from "./server";

async function main(): Promise<void> {
  const config = loadConfig();
  const db = openNodeDatabase(config.dbPath);
  const version = migrate(db);

  // A stable identity so a client can tell "same server, reconnected" from
  // "a different server, my seq cursor is meaningless".
  let serverId = getMeta(db, "server_id");
  if (!serverId) {
    serverId = randomUUID();
    setMeta(db, "server_id", serverId);
  }

  const running = await listen(db, serverId, config.port, config.host, {
    webDir: config.webDir,
  });
  console.log(`[sync] Planner sync server`);
  console.log(`[sync]   database  ${config.dbPath} (schema v${version})`);
  console.log(`[sync]   listening ws://${config.host}:${running.port}/ws`);
  console.log(`[sync]   health    http://localhost:${running.port}/health`);
  if (config.webDir) {
    console.log(`[sync]   app       http://localhost:${running.port}/`);
  }

  const shutdown = async () => {
    console.log("\n[sync] shutting down");
    await running.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Started by the Mac app: don't outlive it if it crashes or is force-quit,
  // or the next launch finds the port taken by an orphan.
  if (process.env.PLANNER_EXIT_WITH_PARENT === "1") {
    const parent = process.ppid;
    setInterval(() => {
      try {
        process.kill(parent, 0);
      } catch {
        void shutdown();
      }
    }, 2000).unref();
  }
}

main().catch((err) => {
  console.error("[sync] failed to start:", err);
  process.exit(1);
});
