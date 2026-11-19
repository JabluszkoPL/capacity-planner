# Planner

[![CI](https://github.com/JabluszkoPL/capacity-planner/actions/workflows/ci.yml/badge.svg)](https://github.com/JabluszkoPL/capacity-planner/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/JabluszkoPL/capacity-planner)](https://github.com/JabluszkoPL/capacity-planner/releases/latest)

Capacity planning: define projects made of epics and tasks with day estimates,
define teams of people with specializations, speeds and days off, then run a
deterministic scheduler that assigns the work and draws the timeline.

This is the multi-platform rebuild of the original browser-only Planner,
restructured along the lines of [t3code](https://github.com/pingdotgg/t3code):
a pnpm monorepo of small packages, with each platform as a thin app on top.

|                   |                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------- |
| **Web**           | React + Vite, runs in any browser, works offline                                        |
| **macOS**         | Electron wrapping the same web build, with a real SQLite database                       |
| **Sync**          | Node + SQLite WebSocket server that keeps devices in step; the Mac app runs one for you |
| **iOS / Android** | Reserved — see [`apps/mobile`](apps/mobile/README.md)                                   |

## Download the Mac app

Get the latest `.dmg` from
[Releases](https://github.com/JabluszkoPL/capacity-planner/releases/latest),
drag Planner into Applications, and allow it once in System Settings → Privacy
& Security (the build isn't notarized yet — [details](apps/desktop/FOR-TESTERS.md)).

From then on it **updates itself**: when a new release is published, the
version in the top bar turns into "Update to …", and one click downloads,
verifies and installs it.

## Same data in the app and in a browser

While the Mac app is open, open <http://localhost:5191> in any browser on the
same Mac — it's the same app on the same data, kept in step live. For several
machines, run `pnpm serve` on one of them and open `http://<that-machine>:5191`
everywhere. Any browser can also be pointed at a server from the app: click the
version in the top bar → **Sync**. More in [docs/SYNC.md](docs/SYNC.md).

Used Planner in a browser before and want it all in the Mac app? Follow
[docs/MOVING_TO_THE_MAC_APP.md](docs/MOVING_TO_THE_MAC_APP.md).

## Run from source

```bash
pnpm install
pnpm dev:web
```

Then open <http://localhost:5190>. No server, no database setup, no accounts —
the app keeps everything on your machine.

## Everything you can run

```bash
pnpm dev:web        # web app on :5190
pnpm dev:server     # sync server on :5191 (only needed for multi-device)
pnpm dev            # both at once
pnpm dev:desktop    # Mac app against the dev server (run dev:web first)
pnpm serve          # build the web app and serve it + sync on :5191

pnpm test           # every package's tests
pnpm typecheck      # tsc over the whole workspace
pnpm lint
pnpm format

pnpm build:web      # production web bundle -> apps/web/dist
pnpm build:mac      # signed-less .dmg + .zip -> apps/desktop/release
pnpm version:set X  # bump the version everywhere before a release
```

Updating a clone is `git pull && pnpm install`; the app tells you in the top
bar when a newer release exists.

## Layout

```
apps/
  web/         React UI — every screen, component and stylesheet
  desktop/     Electron shell for macOS; owns the SQLite file
  server/      WebSocket sync server (optional)
  mobile/      reserved for React Native / Expo
packages/
  core/        the domain: types, scheduler, layout, exporters — no React, no DOM
  contracts/   sync protocol: entities, hybrid logical clock, wire format
  db/          SQLite schema, migrations, merge rule, AppState assembly
  client-runtime/  local database port, sync client, React store
```

The dependency direction is strictly downward — `core` knows about nothing,
`contracts` knows about nothing, and no package imports an app.

## How the pieces fit

**The scheduler is the whole point and it is pure.** `packages/core` has no
React, no DOM and no Node built-ins, so the identical scheduling code runs in a
browser tab, in the Mac app's renderer, on the server, and on a phone later.
It is covered by 114 tests.

**The UI never learns that a database exists.** Components dispatch the same
typed actions they always have; the reducer produces a new `AppState`; the
runtime diffs it against what is stored and emits one op per row that changed.

**Every device holds a full copy.** Planner is local-first: the app is fully
usable with no network and no server. Sync, when you turn it on, is a background
process that drains an outbox upward and merges ops downward.

Details: [architecture](docs/ARCHITECTURE.md) · [sync design](docs/SYNC.md) ·
[the Mac app](docs/DESKTOP.md) · [releasing](docs/RELEASING.md) ·
[accessibility](docs/ACCESSIBILITY.md) ·
[Google Sheets export](docs/GOOGLE_SHEETS.md) ·
[Jira tracking](docs/JIRA_TRACKING.md) ·
[moving to the Mac app](docs/MOVING_TO_THE_MAC_APP.md)

## Where your data lives

| Platform    | Location                                               |
| ----------- | ------------------------------------------------------ |
| Web         | IndexedDB, database `planner`                          |
| macOS       | `~/Library/Application Support/Planner/planner.sqlite` |
| Sync server | `~/Library/Application Support/Planner/state.sqlite`   |

The Mac app's built-in server uses that same `state.sqlite`.

The macOS and server files are ordinary SQLite databases with ordinary tables —
open either in any SQLite browser and your projects, epics, tasks and people are
right there.

Opening the web app on the same origin as the original localStorage-only Planner
imports that data automatically on first run, once. The old key is left
untouched.

## Requirements

Node 22.5+ (for the built-in `node:sqlite`) and pnpm 10+. Building the Mac app
additionally needs macOS.

## Contributing

Issues and pull requests are welcome. Before opening a PR, `pnpm typecheck`,
`pnpm lint`, `pnpm format:check` and `pnpm test` should pass — CI runs the same.
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains the package boundaries;
`CLAUDE.md` / `AGENTS.md` hold the conventions for coding agents and humans
alike. Releases are cut by tagging — see [docs/RELEASING.md](docs/RELEASING.md).

To run your own fork with its own updates, change `repository` in the root
`package.json` to your fork; the app then checks your releases.

## License

[MIT](LICENSE)
