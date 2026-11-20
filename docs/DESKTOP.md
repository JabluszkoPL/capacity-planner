# The Mac app

An Electron shell around the exact same web build a browser gets. The window
points at it, the preload script hands it a database, and the app never learns
which host it is in — `apps/web/src/runtime.ts` picks its `LocalStore` based on
whether `window.planner` exists.

## Running it

```bash
pnpm dev:web        # terminal 1 — the renderer
pnpm dev:desktop    # terminal 2 — Electron against http://localhost:5190
```

## Building a .dmg

```bash
pnpm build:mac
```

Produces `apps/desktop/release/`:

| File                              |                                                      |
| --------------------------------- | ---------------------------------------------------- |
| `Planner-0.1.0-universal.dmg`     | ~192 MB, what you hand to a tester                   |
| `Planner-0.1.0-universal-mac.zip` | same app; what the built-in updater installs         |
| `FOR-TESTERS.md`                  | plain-language install steps, copied in by the build |

**Universal**, not per-architecture: a build handed to someone else has to run
on whatever Mac they have, and picking the wrong download is a support
conversation nobody wants. One file covers Apple Silicon and Intel.

Releases are built and published by CI from a version tag — see
[RELEASING.md](RELEASING.md).

## Updates

The app checks this repository's GitHub releases and installs newer versions
itself: the version next to **Settings** in the sidebar becomes **Update to vX.Y.Z**, and the About
panel downloads, verifies and swaps in the new build on restart. How, and why
it is not electron-updater: [RELEASING.md](RELEASING.md).

## Sharing with browsers

While the app is open it runs the sync server (`apps/server`, bundled as
`dist/sync-server.cjs` and unpacked from the asar) as a child process on
`127.0.0.1:5191`, connects to it, and serves the web app from it. Any browser on
the Mac can open `http://localhost:5191` and work on the same data live. The
About panel shows the address and has an **Open in browser** button.

The server keeps its own copy at
`~/Library/Application Support/Planner/state.sqlite`, exits with the app (even
if the app crashes), and joins an already-running Planner server on that port
instead of fighting it for the port. If it can't start, the app runs local-only
as before. `PLANNER_SHARE=0` turns it off. Details: [SYNC.md](SYNC.md).

## Signing, and what testers will hit

The build is **ad-hoc signed** and **not notarized**.

`afterPack.mjs` applies the ad-hoc signature, because electron-builder cannot:
its `identity` field only accepts the _name_ of a certificate in the keychain,
so the conventional `identity: "-"` is looked up as a name, not found, and
signing is skipped silently. An entirely unsigned bundle makes Apple Silicon
report the app as "damaged and can't be opened", which is much worse than the
honest "unidentified developer" prompt. Verify with:

```bash
codesign --verify --deep --strict apps/desktop/release/mac-universal/Planner.app
```

An ad-hoc signature carries no identity, so Gatekeeper still rejects the app and
the recipient clears it once by hand — System Settings → Privacy & Security →
**Open Anyway**, or `xattr -dr com.apple.quarantine /Applications/Planner.app`.
`FOR-TESTERS.md` spells this out for a non-technical reader.

### Doing it properly

A clean double-click launch needs a **Developer ID Application** certificate
plus notarization. Two certificate types are commonly mistaken for it and
neither works:

- **Apple Development** — restricts the app to devices listed on its
  provisioning profile. It would run on the build machine and nowhere else.
- **Apple Distribution** — App Store / TestFlight submission only.

With a real Developer ID: put its name in `mac.identity`, set
`hardenedRuntime: true`, add a `notarize` block, and drop the `afterPack` hook.

## The database## The database

`~/Library/Application Support/Planner/planner.sqlite` — an ordinary SQLite
file with ordinary tables. Open it in any SQLite browser:

```sql
SELECT p.name AS project, e.name AS epic, t.name AS task, t.estimate_days
FROM tasks t
JOIN epics e ON e.id = t.epic_id
JOIN projects p ON p.id = t.project_id
WHERE t.deleted = 0
ORDER BY p.position, e.position, t.position;
```

Set `PLANNER_DATA_DIR` to put it somewhere else — useful for trying things
without touching your real data.

## How the renderer reaches it

The renderer runs with `contextIsolation` on and `nodeIntegration` off, so it
cannot open a database itself, and shouldn't: that would mean handing web
content filesystem access. The main process owns the handle and exposes exactly
eight database calls plus three read-only facts across the context bridge —
no filesystem, no shell, no arbitrary IPC.

## Window chrome

The window is frameless on macOS (`titleBarStyle: "hidden"`) so the app's own
header can sit at the very top. That alone is not enough: it leaves the
close/minimise/zoom buttons floating over the header text, and no chrome to drag
the window by.

So the renderer draws its own 34px strip above the header
(`apps/web/src/components/layout/TitleBar.tsx`), marked
`-webkit-app-region: drag`. The main process positions the traffic lights at
`(14, 11)` to sit centred in that band. The strip shares the header's background
and has no border, so the two read as a single taller bar with the window
buttons tucked into its top-left.

The header itself is draggable too — an app you can only move by a 34px sliver
is still annoying — with links and buttons inside it opted back out via
`no-drag`, or they would stop responding to clicks.

None of this exists in a browser tab. `applyHostAttributes()` sets
`data-host="electron"` on `<html>`, `--titlebar-h` stays `0px` without it, and
`<TitleBar />` renders nothing. Windows and Linux keep their native frame, since
hiding it there would leave a window with no way to close it.

## Two things worth knowing

**Electron must be new enough for `node:sqlite`.** It arrived in Node 22.5, so
Electron 35+ (Node 22.14+) is the floor. Building against Electron 33 (Node 20)
produces an app that starts, opens no window and prints nothing — the failure
mode that cost the most time here. The main process now catches it and shows a
dialog naming the Node and Electron versions.

**The app name is pinned in code.** Left alone, Electron derives `userData` from
the package's `name` — the scoped workspace name `@planner/desktop` — and would
put the database in a nested `Application Support/@planner/desktop` folder that
differs between the dev and packaged builds. `app.setName("Planner")` runs
before anything asks for a path.
