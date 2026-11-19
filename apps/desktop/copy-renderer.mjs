/**
 * Copy the web app's production build in as the Electron renderer.
 *
 * The Mac app ships the same bundle the browser gets — this is the only step
 * that makes it a desktop app rather than a second implementation.
 */
import { cpSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const source = resolve("../web/dist");
const target = resolve("renderer");

if (!existsSync(source)) {
  console.error(
    `[planner] ${source} not found — build the web app first:\n` +
      `          pnpm --filter @planner/web build`,
  );
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
console.log(`[planner] renderer <- ${source}`);
