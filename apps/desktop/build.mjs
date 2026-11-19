/**
 * Bundle the Electron main and preload scripts, plus the sync server the app
 * runs as a child process (see electron/shareServer.ts).
 *
 * A bundler is needed rather than plain `tsc` because the workspace packages
 * are published as TypeScript source (`main: ./src/index.ts`) — the main
 * process imports @planner/db and @planner/client-runtime directly, and Node
 * cannot load those as-is. Electron and Node built-ins stay external so the
 * runtime provides them.
 *
 * The version and release repository come from the workspace root
 * package.json, the same values the web bundle gets.
 */
import { build } from "esbuild";
import { readFileSync, rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });

const rootPackage = JSON.parse(readFileSync("../../package.json", "utf8"));

const common = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: true,
  external: ["electron"],
  logLevel: "info",
  define: {
    __PLANNER_VERSION__: JSON.stringify(rootPackage.version ?? "0.0.0"),
    __PLANNER_REPOSITORY__: JSON.stringify(rootPackage.repository ?? null),
  },
};

await build({
  ...common,
  entryPoints: ["electron/main.ts"],
  outfile: "dist/main.cjs",
});

await build({
  ...common,
  entryPoints: ["electron/preload.ts"],
  outfile: "dist/preload.cjs",
});

// The sync server is its own app; it is built from its entry point and shipped
// as a file, never imported. `ws` has optional native accelerators it loads
// with a guarded require; bundling them is neither possible nor needed.
await build({
  ...common,
  entryPoints: ["../server/src/main.ts"],
  outfile: "dist/sync-server.cjs",
  target: "node22",
  external: ["bufferutil", "utf-8-validate"],
});
