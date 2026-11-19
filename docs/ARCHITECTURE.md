# Architecture

## Why it is shaped like this

The original Planner was one Vite app: React components, a `useReducer` store,
and `localStorage`. Everything worked, and none of it could leave the browser.

The rebuild keeps the parts that were already good — the scheduling engine, the
data model, the reducer, the whole UI — and changes only where they live. Each
one moved into a package whose dependencies say what it is allowed to touch:

```
        ┌───────────┐   ┌───────────────┐
        │   core    │   │   contracts   │      no dependencies at all
        └──┬─────┬──┘   └───────┬───────┘
           │     │              │
           │     └───────┬──────┘
           │             ▼
           │          ┌──────┐
           │          │  db  │                schema, merge rule, assembly
           │          └──┬───┘
           │             ▼
           │    ┌─────────────────┐
           ▼    │ client-runtime  │            local store, sync client, React store
        ┌──────┐└────────┬────────┘
        │ jira │         │                     Jira vocabulary; transport injected
        └───┬──┘         │
            ├────────────┤
            │            ▼
            │       ┌─────────┐
            │       │   mcp   │                MCP protocol and tools; no socket
            │       └────┬────┘               (used by web and desktop only)
            └─────┬──────┴────────┐
        ┌─────────┼───────────────┼───────┐
        ▼         ▼               ▼       ▼
    apps/web  apps/desktop   apps/server
```

Nothing imports upward, and no package imports an app. That is what makes it
possible to add a React Native app later without touching a line of the domain.

## packages/core — the domain

Types, the scheduler, the timeline layout, the Excel writer, date maths, colour
mapping, the paste-from-Sheets parser, the demo seed.

The rule is total: **no React, no DOM, no Node built-ins.** A test in
`scheduling.test.ts` asserts it for the scheduler specifically, because that is
the file most likely to sprout a convenience import.

Where the original code mixed a pure builder with a browser download (`buildXlsxBytes`
next to `buildXlsxBlob`), the split now runs along the package boundary: the
builder is in core, the `Blob` is in `apps/web/src/lib/download.ts`.

## packages/contracts — the sync vocabulary

What a synced row is (`Op`), how edits are ordered (a hybrid logical clock), and
what goes over the socket. Depends on nothing — not even `core` — so the server
never links the scheduling engine just to relay a row.

## packages/jira — the Jira vocabulary

Link parsing, JQL construction, field discovery, the mappers that turn Jira's
JSON into a `JiraSnapshot`, and the refresh orchestration. Like `core` it is
pure: no React, no DOM, no Node built-ins, and — the important one — **no
`fetch`**.

The HTTP call is injected as a `JiraTransport`, because the one thing that
genuinely differs between hosts is whether a cross-origin request to Atlassian
is possible at all. Jira Cloud sends no CORS headers, so a browser tab simply
cannot call it: the Mac app goes through Electron's main process, a browser goes
through the sync server's `/api/jira` proxy, and a browser with neither can
still read the last snapshot it synced but cannot refresh. Keeping the transport
out of the package means all three share one client and one set of tests.

Both hosts that *can* reach Jira validate the target before opening a socket
(`apps/desktop/electron/jira.ts`, `apps/server/src/jiraProxy.ts`): an Atlassian
host, a REST path, and writes only when explicitly enabled. Those two are the
only places in the system that will fetch a URL on the user's behalf, so the
rule is duplicated deliberately rather than shared through a package an app
could forget to call.

## packages/db — SQLite

The schema, its migrations, the last-write-wins merge, and the assembly of rows
back into the `AppState` the UI renders.

It talks to a five-method `SqliteDriver` interface rather than to a concrete
handle, because the same schema has to run on `node:sqlite` today and
`expo-sqlite` later. The one Node-specific file sits behind its own entry point
(`@planner/db/node`) so bundling the web app never drags a Node built-in into
the browser graph.

### The tables

One table per entity, each carrying three sync columns: `hlc` (the stamp of the
edit that won), `deleted` (a tombstone, kept so offline peers learn about
deletions), and `dirty` (client-side: not yet acked).

Collections that only exist as part of their parent — a member's off-days, a
task's `dependsOn`, an epic's assigned members — are JSON on the parent row
rather than tables of their own. Finer-grained merging there would buy very
little and would add a large surface where a half-applied merge could produce a
shape the scheduler rejects.

A `plan` is derived output, so it syncs as one opaque row per project: your
phone can see the plan your Mac produced without re-running the engine. A
`tracker` works the same way and for the same reason — its Jira snapshot is
regenerable by pressing Refresh — but its `samples` are not: one reading per
refresh day is the only record of how the buffer has been spent over time, and
no amount of re-fetching brings back last week's.

## packages/client-runtime — the seam

`LocalStore` is the local database, as an interface. Three implementations:

| Implementation           | Used by              | Backed by                                |
| ------------------------ | -------------------- | ---------------------------------------- |
| `createMemoryLocalStore` | browser              | in-memory row index + IndexedDB snapshot |
| `createSqliteLocalStore` | Electron main, tests | real SQLite                              |
| `createBridgeLocalStore` | Electron renderer    | IPC to the main process                  |

The browser one is not a lesser version: running SQLite in a tab means shipping
a wasm build and wrestling with OPFS, and Planner's dataset is a few hundred
rows. What matters is that both obey the _same_ merge rule — so the contract is
written once in `conformance.ts` and run against both. A divergence there would
show up as two devices quietly disagreeing about the same project, which is the
worst bug a sync system can have and the hardest to notice.

`PlannerRuntime` ties a store, a clock and an optional sync client together. The
React store takes one and knows nothing else about persistence.

## packages/mcp - AI clients

The Model Context Protocol server, minus the socket: JSON-RPC handling, the
tool catalogue (each tool's JSON schema is also its argument validator) and
every tool. Pure, like `core`. A read tool is a function of `AppState`; a write
tool returns the typed `Action`s a click would dispatch. It imports only the
`Action` type from client-runtime (`@planner/client-runtime/actions`), never
the React store.

Two hosts share it. The Mac app's main process serves it over loopback HTTP
with a bearer token and lists tools from the catalogue; each call is relayed
to the window, which runs the tool on its live store and dispatches the
actions. So an AI client's edit takes exactly the path below, and UI tools can
navigate the window. See [MCP.md](MCP.md).

## How an edit travels

1. A component calls an action. The reducer returns a new `AppState`.
2. The provider effect diffs it against the last state it persisted.
   `diffStates` walks both and emits one op per row that actually changed.
3. `store.applyLocal(ops)` merges them locally and queues them in the outbox.
4. The sync client — if there is one — pushes the outbox and clears it on ack.
5. Ops from other devices arrive, merge, and the provider re-reads and adopts
   the result. Adopted state is never diffed back down, so a remote change
   cannot echo.

Diffing whole states on every dispatch is O(size-of-state). For a few hundred
tasks that is microseconds, and it buys a persistence layer that cannot drift
out of step with the reducer — every edit is derived from the same value the UI
renders.

## Deliberate deviations from t3code

t3code is a shipped product, not a template, and some of its choices are load
bearing there and not here.

| t3code                                  | Planner                     | Why                                                                                 |
| --------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------- |
| Vite+ (`vp`)                            | plain Vite + pnpm           | `vp` is early access; nothing here needs it                                         |
| Effect + `@effect/atom`                 | plain reducer + Context     | the reducer already existed and is fully tested                                     |
| Event sourcing with deciders/projectors | row-level LWW over an oplog | one user across their own devices; full event sourcing is machinery without a payer |
| Effect Schema contracts                 | hand-written type guards    | keeps the original project's zero-runtime-dependency rule                           |
| Clerk auth                              | none                        | single user, no accounts                                                            |

What was worth copying is the shape: apps over packages, a pure domain, a
transport-free server core, and one client runtime shared by every platform.
