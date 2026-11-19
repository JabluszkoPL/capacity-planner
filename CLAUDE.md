# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## What this is

Planner is a capacity-planning app: projects made of epics/tasks with day
estimates, teams of people with specializations/speeds/off-days, and a
deterministic scheduler that assigns the work and renders a Gantt timeline.

It is a **pnpm monorepo** shaped after
[t3code](https://github.com/pingdotgg/t3code): apps over packages, a pure
domain, and one client runtime shared by every platform. It ships a web app and
a macOS app today; `apps/mobile` is reserved for React Native.

It is **local-first**: every device holds a full copy and works offline. The
Mac app runs the sync server for itself on `127.0.0.1:5191` (so a browser on
the same Mac sees the same data); running a shared one is optional.

It is published at <https://github.com/JabluszkoPL/capacity-planner> (public,
MIT). Releases are git tags; see [docs/RELEASING.md](docs/RELEASING.md).

This replaces the earlier browser-only, `localStorage`-only Planner at
`../Planner`. That project is history, not a live reference.

## Commands

```bash
pnpm install
pnpm dev:web        # web app on :5190
pnpm dev:server     # sync server on :5191
pnpm dev            # both
pnpm dev:desktop    # Electron against the dev server (needs dev:web running)
pnpm serve          # build web, serve it + sync on :5191

pnpm test           # every package
pnpm typecheck
pnpm lint
pnpm format

pnpm build:web
pnpm build:mac      # .dmg + .zip -> apps/desktop/release
pnpm version:set 0.2.0   # bump every package.json before tagging a release
```

A single package or test:

```bash
pnpm --filter @planner/core test
pnpm --filter @planner/db test -- -t "last-write-wins"
```

CI (`.github/workflows/ci.yml`) runs typecheck, lint, format check and tests
on every push and PR. Pushing a `v*` tag runs `release.yml`, which builds the
Mac app on a macOS runner and publishes a GitHub release.

## Architecture

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first — it explains the
package boundaries and why each one exists. The short version:

**Dependencies point strictly downward.** `core` and `contracts` depend on
nothing. `db` depends on both. `client-runtime` depends on `db`. Apps depend on
packages. Nothing imports an app. Preserve this — it is what keeps a React
Native app a UI-only job.

**`packages/core` is the domain and must stay pure.** No React, no DOM, no Node
built-ins. `src/types.ts` is the single source of truth for every shared shape;
read its doc comments before changing a model. `src/scheduling.ts` is the heart
of the app — read its module docstring before touching it, and expect the 63
tests in `scheduling.test.ts` to be the real specification. A test asserts the
scheduler imports neither React nor the DOM.

**`packages/db` owns persistence and merging.** The schema is append-only:
never edit a shipped migration, add a new one, because a device offline since
the last release replays exactly those statements. Everything goes through the
five-method `SqliteDriver` interface so the same code runs on `node:sqlite`
today and `expo-sqlite` later; the one Node-specific file is behind the separate
`@planner/db/node` entry point so the web bundle never pulls a Node built-in.

**One merge rule, tested against every implementation.** Last-write-wins by HLC
stamp. The browser store and the SQLite store are different code, so the
contract lives once in `packages/client-runtime/src/conformance.ts` and both are
required to pass it. Add a case there, not to one store's own tests.

**The UI never learns that a database exists.** Components dispatch typed
actions, the reducer returns a new `AppState`, and the provider diffs it against
what was last persisted. When you add a field to the model you must also teach
`packages/db/src/rows.ts` about it (a descriptor entry and a payload projection)
or it will silently not persist.

**`apps/web` is the only UI, and the Mac app runs the same bundle.**
`apps/web/src/runtime.ts` picks a `LocalStore` based on whether Electron's
`window.planner` bridge is present. Do not fork the UI per platform.

**Jira tracking is a tracker entity plus an injected transport.** A `Tracker`
links a Jira initiative to a baseline project and syncs like any other row; its
`snapshot` is derived data (regenerable by refreshing) but its `samples` are
not, since they are the only record of how the buffer has been spent over time.
`packages/jira` holds everything Jira-specific and stays pure — it never calls
`fetch`, because Jira Cloud sends no CORS headers and only some hosts can reach
it at all (`apps/web/src/lib/jiraTransport.ts` picks one, exactly as
`runtime.ts` picks a store). The comparison maths lives in
`packages/core/src/tracking.ts`; read its docstring before touching it, and note
that it measures against the plan **re-run with `buffer: 0`**, because measuring
against the buffered plan silently spends the buffer you are trying to watch.
See [docs/JIRA_TRACKING.md](docs/JIRA_TRACKING.md).

**Jira credentials never enter `AppState`.** They live in `localStorage` per
device (`apps/web/src/lib/jiraSettings.ts`). Everything in AppState is diffed
into ops, pushed to the sync server, replicated to every device and written into
the JSON export — all of which are the wrong places for an API token. Keep it
that way when adding fields.

## Conventions

- **Absent field = backward-compatible default**, by design. Absent
  `teamInclusions` means every team participates; absent `planMode` means
  balanced. Preserve this when adding optional fields, and note that the
  database cannot tell `helpers: []` from an absent `helpers` — use
  `canonicalState()` when comparing an in-memory state to a persisted one.
- **Member ids are globally unique across all teams**, so per-project maps keyed
  by member id work regardless of team. Use the helpers in `core/src/teams.ts`
  for "all people".
- **Ids are generated client-side**, never by the server, so a device offline
  can create entities that keep their identity once they sync.
- Tests are co-located (`*.test.ts` / `*.test.tsx`), Vitest + Testing Library.
  Node environment by default; a test needing a DOM opts in with a
  `// @vitest-environment jsdom` docblock.
- TypeScript is strict with `noUnusedLocals`/`noUnusedParameters`; prefix
  intentionally-unused bindings with `_`. Prettier: 2-space, double quotes,
  trailing commas, 80 cols.
- **Keep the dependency list short.** Runtime deps are React, React Router and
  `ws`. The `.xlsx` writer is hand-rolled and dependency-free; the sync protocol
  uses hand-written type guards rather than a schema library. Prefer a small
  local implementation over a package.

## Versions, updates and sharing

- **The root `package.json` is the version and the release repository.** Vite
  and the desktop esbuild inject them as `__PLANNER_VERSION__` /
  `__PLANNER_REPOSITORY__`. The `apps/*/package.json` copies exist for
  electron-builder; `pnpm version:set` keeps them equal and a test fails if
  they drift.
- **The updater is hand-rolled on purpose** (`apps/desktop/electron/updater.ts`,
  pure parts in `updateInstall.ts`). Squirrel.Mac rejects ad-hoc signed
  updates. It may only reach `api.github.com/repos/<repo>/releases/latest` and
  that repository's own release assets, and installs only after size, SHA-256,
  `codesign --verify` and version checks. The release-parsing rules shared
  with the browser live in `packages/core/src/releases.ts`.
- **The Mac app's sync server is a child process**
  (`apps/desktop/electron/shareServer.ts`) running the bundled
  `apps/server` entry with `ELECTRON_RUN_AS_NODE`. The desktop app never
  imports the server's code; `build.mjs` bundles it as a file and
  `electron-builder.yml` unpacks it from the asar.
- **Every browser request to the server passes `apps/server/src/access.ts`**
  (loopback/IP Host, trusted Origin) — WebSockets have no CORS, and the server
  holds the whole plan. Don't add routes that bypass it.
- A browser picks its sync server in `apps/web/src/runtime.ts`: Mac host →
  per-browser setting (`lib/syncSettings.ts`, localStorage) → the server that
  served the page (`<meta name="planner-sync">`) → `VITE_SYNC_URL`.

## Traps worth knowing

- **Electron must bundle Node 22.5+** for `node:sqlite`. An older Electron
  starts, opens no window and prints nothing. See [docs/DESKTOP.md](docs/DESKTOP.md).
- **`app.setName("Planner")` must run before anything asks for a path**, or the
  database lands in a folder named after the npm scope.
- **Don't run `tsc` with emit in an app.** Vite bundles; `tsc` is only there to
  fail on type errors. An emitting build litters `.js` next to every source.
- **`runtime.load()` is memoised** because React 18 StrictMode runs effects
  twice; without it two loads race and each seeds the demo project.

## Jira tracking

`docs/JIRA_TRACKING.md` is the user-facing setup; `docs/JIRA_TRACKING.html` is
the design record (the on-track and buffer maths is spelled out there in full).
Two things are easy to get wrong:

- **Only two files may reach an arbitrary URL** on the user's behalf (the
  updater and the browser update check reach fixed GitHub URLs only):
  `apps/desktop/electron/jira.ts` and `apps/server/src/jiraProxy.ts`. Both
  validate the host and path before any socket opens, and both refuse writes
  unless explicitly enabled. Besides the Jira REST API they allow only the
  read-only Teams directory shapes (team list, one team's members, and three
  fixed GraphQL queries — org-id lookup, team search, team members — checked
  by body; the `X-ExperimentalApi` header is forwarded to GraphQL only). Their guards are duplicated on purpose — a shared
  helper is a helper an app can forget to call.
- **Writes to Jira are dates only**, behind a preview and an explicit
  confirmation, and off by default on both the server (`PLANNER_JIRA_WRITES=1`)
  and the client (a settings toggle).

## Accessibility

The app is fully keyboard-operable and this is a maintained property — see
[docs/ACCESSIBILITY.md](docs/ACCESSIBILITY.md) for the expected focus and
keyboard behavior of modals, cards and forms. Preserve it.
