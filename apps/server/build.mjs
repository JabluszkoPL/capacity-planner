/**
 * Bundle the sync server.
 *
 * Node's `--experimental-strip-types` can run a lone .ts file, but it keeps
 * Node's own resolution rules — extensionless relative imports don't resolve,
 * and neither do the workspace packages, which are published as TypeScript
 * source. Bundling sidesteps both and leaves a single deployable file.
 *
 * `--watch` rebuilds and respawns on change; that is what `pnpm dev:server` uses.
 */
import { context, build } from "esbuild";
import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";

const watch = process.argv.includes("--watch");
const outfile = "dist/server.cjs";

rmSync("dist", { recursive: true, force: true });

// The workspace root package.json is the one version (see CLAUDE.md); /health
// reports it so the Mac app can tell which build is answering on its port.
const rootPackage = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
);

const options = {
  entryPoints: ["src/main.ts"],
  outfile,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  sourcemap: true,
  // `ws` has optional native accelerators it loads with a guarded require;
  // bundling them is neither possible nor needed.
  external: ["bufferutil", "utf-8-validate"],
  logLevel: "info",
  define: {
    __PLANNER_VERSION__: JSON.stringify(rootPackage.version ?? "0.0.0"),
  },
};

if (!watch) {
  await build(options);
  process.exit(0);
}

let child = null;
const restart = () => {
  child?.kill();
  child = spawn(process.execPath, [outfile], { stdio: "inherit" });
};

const ctx = await context({
  ...options,
  plugins: [
    {
      name: "restart",
      setup(b) {
        b.onEnd((result) => {
          if (result.errors.length === 0) restart();
        });
      },
    },
  ],
});
await ctx.watch();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    child?.kill();
    void ctx.dispose().then(() => process.exit(0));
  });
}
