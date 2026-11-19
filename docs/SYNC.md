# Sync

Planner is local-first. Every device holds a complete copy of the data and is
fully usable with the network down; the sync server is an optional relay that
lets several devices converge. Most people will never run one.

## Turning it on

There are three ways, from least to most setup.

**The Mac app already runs one.** While it is open it serves its data on
`http://localhost:5191`. Open that address in any browser on the same Mac and
you get the same app with the same projects, kept in step live. It listens on
loopback only, so nothing on the network can reach it. Set `PLANNER_SHARE=0`
before launching to turn this off, or `PLANNER_SHARE_PORT` to move it.

**A browser can be pointed at a server from the app.** Click the version in
the header → **Sync** → enter `localhost:5191` (or any server address) →
**Connect**. The choice is stored in that browser only. Whatever this browser
held is merged into the server's data — nothing is overwritten wholesale; the
merge rule below applies row by row.

**Run a server for several machines.**

```bash
pnpm serve          # builds the web app, serves it and sync on :5191
```

Everyone opens `http://<that-machine>:5191`. The page knows it came from a
sync server (`<meta name="planner-sync">`, injected by
`apps/server/src/staticFiles.ts`) and syncs with it automatically.

For development, `pnpm dev:server` plus `VITE_SYNC_URL=ws://localhost:5191/ws
pnpm dev:web` still works, and `PLANNER_SYNC_URL` points the Mac app at a
server of your choosing instead of its own.

There is no authentication. Run a shared server on a network you trust, or
behind something that provides one.

### Who may connect

A WebSocket is not covered by CORS, so without a check any website open in the
user's browser could connect to `localhost:5191` and read or rewrite the plan.
`apps/server/src/access.ts` therefore requires browser requests to be
addressed to a loopback name or an IP literal (which defeats DNS rebinding),
and to come from a loopback page, the server's own origin, or the packaged Mac
app. A server deployed behind a real hostname lists it in
`PLANNER_ALLOWED_HOSTS`.

| Variable                | Default                                              | Meaning                        |
| ----------------------- | ---------------------------------------------------- | ------------------------------ |
| `PLANNER_PORT`          | `5191`                                               | server port                    |
| `PLANNER_HOST`          | `0.0.0.0`                                            | bind address                   |
| `PLANNER_DB`            | `~/Library/Application Support/Planner/state.sqlite` | server database                |
| `PLANNER_WEB_DIR`       | `apps/web/dist` if built                             | web build served at `/`        |
| `PLANNER_ALLOWED_HOSTS` | unset                                                | extra trusted hostnames        |
| `VITE_SYNC_URL`         | unset                                                | web app's server, build-time   |
| `PLANNER_SYNC_URL`      | unset                                                | Mac app's server, launch-time  |
| `PLANNER_SHARE`         | on                                                   | `0`: Mac app runs no server    |
| `PLANNER_SHARE_PORT`    | `5191`                                               | Mac app's built-in server port |

`GET /health` reports the protocol version, the log head and the connection
count. `GET /api/state` dumps the current state as JSON for inspection (same
origin only). Writes only ever go over the socket — there is no mutating HTTP
surface.

A browser picks its server in this order: the Mac app's choice, the one set in
the app's Sync settings, the server the page was loaded from, then
`VITE_SYNC_URL` (`apps/web/src/runtime.ts`).

## The merge rule

Every synced row carries a hybrid logical clock stamp, and **the higher stamp
wins**. That is the entire conflict resolution story, and it is deliberately
the same three lines on every peer, so the server holding a materialised copy
is a convenience rather than an authority.

A hybrid clock rather than a plain timestamp because the rule has to satisfy
two things at once: an edit made later should generally win, _and_ the ordering
must be total even when two devices have skewed clocks or edit within the same
millisecond. So a stamp is physical milliseconds, a counter that breaks ties and
absorbs skew, and the device id as a final tiebreak:

```
01a037b99da0-0009-dev-a3f91c
└ 48-bit ms ┘ └ctr┘ └device┘
```

Fixed width, so plain string comparison _is_ clock comparison — which is what
lets SQLite order stamps with no custom collation.

Two consequences worth knowing:

- **Sync granularity is the row.** Two devices editing different tasks in the
  same epic merge cleanly. Two devices editing the _same_ task concurrently
  resolve last-write-wins — one of the two edits is discarded. For one person
  across their own machines that is the right trade; for a shared team server it
  would not be.
- **A device with a badly wrong clock is ignored, not obeyed.** A stamp more
  than an hour ahead of local time does not advance our clock.

## Deletions

Deleting a row writes a tombstone, not a `DELETE`. The row stays with
`deleted = 1` and the stamp of the deletion, because a device that has been
offline for a week must be able to learn that a project it still holds is gone.
A stale re-create for the same id loses to the tombstone and is discarded.

## The protocol

One WebSocket, JSON frames, discriminated on `t`.

| Client  |                              | Server           |                             |
| ------- | ---------------------------- | ---------------- | --------------------------- |
| `hello` | version + device id + cursor | `welcome`        | server id + log head        |
| `pull`  | everything after a cursor    | `ops`            | a page of ops, oldest first |
| `push`  | a batch of ops               | `ack`            | applied / rejected counts   |
| `ping`  |                              | `pong` / `error` |                             |

The server never merges or rewrites. It assigns each accepted op a global `seq`,
stores it, and fans it out to every peer _except_ the sender — which already
applied the change locally and is waiting only for the ack.

Two sequence numbers are in play and they are not the same thing. The **outbox
seq** is local and only means "these queued ops are now acked, drop them". The
**cursor** is the server's global seq and means "I have durably applied
everything up to here"; it is what a reconnect resumes from. If the server's
identity changes — a rebuilt box, a restored backup — the cursor points into a
stream that no longer exists, so the client resets it and re-pulls from zero.

## The outbox is compacted

Because merging is last-write-wins per row, an older queued op for the same row
can never change the outcome. Queuing a new edit therefore _replaces_ any
pending one for that row, which bounds the outbox by the number of rows a device
has touched rather than by how many times it touched them. That matters most for
someone running with no server at all, whose outbox would otherwise grow
forever.

Replacing an op that is already in flight is safe: the pushed batch was read
before the replacement was made, and the replacement carries a higher seq, so
the incoming ack — which clears only up to the seq it was given — leaves it
queued for the next round. There is a test for exactly this.

## What is tested

`apps/server/src/sync.e2e.test.ts` runs two real clients with real local stores
against a real hub over in-process sockets. Nothing about the merge, the
protocol or the server is mocked — only the transport is shortened. It covers
propagation, no self-echo, concurrent edits to different rows and to the same
row, editing while fully offline, a connection dropped mid-session and
recovering on its own, a late joiner receiving the entire history, and deletes
racing stale edits.
