/// <reference types="vitest/config" />
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The version and release repository come from the workspace root's
 * package.json, the one place a release bumps (`pnpm version:set`). A fork
 * that changes `repository` there gets update checks against its own releases.
 */
const rootPackage = JSON.parse(
  readFileSync(resolve(__dirname, "../../package.json"), "utf8"),
) as { version?: string; repository?: unknown };

/**
 * The config is a function so it can call `loadEnv` first.
 *
 * Vite exposes `.env` values to the *app* as `import.meta.env`, but it does not
 * put them in `process.env` before evaluating this file — so a config that read
 * `process.env.VITE_…` would silently ignore the `.env` sitting next to it and
 * only work when the variable was typed on the command line.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const jiraDevTarget = env.VITE_JIRA_DEV_TARGET;

  return {
    plugins: [react()],
    define: {
      __PLANNER_VERSION__: JSON.stringify(rootPackage.version ?? "0.0.0"),
      __PLANNER_REPOSITORY__: JSON.stringify(rootPackage.repository ?? null),
    },
    // Relative asset URLs, so the identical build works both from a web server
    // and from `file://` inside the packaged Mac app.
    base: "./",
    server: {
      port: 5190,
      strictPort: true,
      // Jira Cloud sends no CORS headers, so a dev page cannot call it
      // directly. In production the app goes through the Mac app's main process
      // or the sync server's /api/jira proxy; this is the same escape hatch for
      // `pnpm dev:web` alone. Unset VITE_JIRA_DEV_TARGET and the route 404s.
      proxy: jiraDevTarget
        ? {
            "/jira-dev": {
              target: jiraDevTarget,
              changeOrigin: true,
              secure: true,
              rewrite: (path: string) => path.replace(/^\/jira-dev/, ""),
              // `changeOrigin` only rewrites the outgoing Host header — the
              // browser's own Origin/Referer (http://localhost:5190) still
              // rides along, and Atlassian's XSRF check rejects a POST (e.g.
              // the JQL search refresh depends on) that carries one from a
              // non-Atlassian origin, no matter what other headers are set.
              configure: (proxy) => {
                proxy.on("proxyReq", (proxyReq) => {
                  proxyReq.removeHeader("origin");
                  proxyReq.removeHeader("referer");
                  proxyReq.removeHeader("cookie");
                  for (const name of proxyReq.getHeaderNames()) {
                    if (
                      name.startsWith("sec-fetch-") ||
                      name.startsWith("sec-ch-")
                    ) {
                      proxyReq.removeHeader(name);
                    }
                  }
                });
              },
            },
          }
        : undefined,
    },
    test: {
      globals: true,
      environment: "jsdom",
      setupFiles: "./src/test/setup.ts",
      css: true,
      // Newer Node (25+) has its own global `localStorage`, which shadows
      // jsdom's and is undefined without `--localstorage-file`, so every test
      // that touches it fails with "Cannot read properties of undefined".
      // Turn Node's off; the flag is only passed where Node knows it.
      poolOptions: {
        forks: {
          execArgv: process.allowedNodeEnvironmentFlags.has(
            "--experimental-webstorage",
          )
            ? ["--no-experimental-webstorage"]
            : [],
        },
      },
    },
  };
});
