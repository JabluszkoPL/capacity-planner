# AI assistants (MCP)

The Mac app can act as a [Model Context Protocol](https://modelcontextprotocol.io)
server, so Claude Code, Codex, Cursor, VS Code and other MCP clients on the same
Mac can read your plans, teams and Jira trackers, open things in the Planner
window and - only if you allow it - change plans and people. It works while
Planner is open.

## Turning it on

1. Open **Settings** (bottom of the sidebar, next to the version number).
2. Open the **AI assistants** section and, under **AI assistants (MCP)**, tick **Allow AI clients to connect**. The
   status line should say it is listening at `http://127.0.0.1:5192/mcp`.
3. Optionally tick **Allow changes to projects, teams and days off**. Off by
   default; without it clients can read and open things but not edit.
4. Copy the setup for your client and run it in Terminal:

   - **Copy for Claude Code**: a `claude mcp add` command (user scope, HTTP
     transport, with the token in an `Authorization` header).
   - **Copy for Codex**: an `export PLANNER_MCP_TOKEN=…` line (put it in your
     shell profile) and a `codex mcp add planner --url …` command that reads
     the token from that variable.
   - **Copy JSON config** - an `mcpServers` block for clients configured with
     JSON (Cursor, VS Code, a project's `.mcp.json`).

   Each one contains this Mac's access token. **New token** replaces it and
   locks out every client set up with the old one.

Then ask, for example: _"Using planner, which projects finish after March?"_,
_"Add Anna's holiday 22–31 December and re-run the Apollo plan"_, or
_"Write a postmortem for the Apollo tracker: what was added after planning,
with Jira links"_.

**ChatGPT** connectors run on OpenAI's servers and need a public HTTPS address,
so they cannot reach an app on your Mac. Planner does not open a tunnel.

## Tools

Arguments that name a project, epic, task, team, member or tracker take its id
or its exact name (case-insensitive; an ambiguous name is refused with the
candidates' ids). Dates are `YYYY-MM-DD`; days off and helper windows also take
ranges `YYYY-MM-DD..YYYY-MM-DD`, which expand to weekdays.

**Read** (always available when on)

| Tool                        | What it returns                                                                                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `list_projects`             | Every project: start, size in days, buffer, teams, stored plan's start/finish, linked trackers.                                                                                            |
| `get_project`               | One project in full: epics, tasks, dependencies, teams and constraints, helpers, the stored plan per epic, per person and per assignment, unassigned tasks, and whether the plan is stale. |
| `preview_plan`              | What Run Plan would produce now, without saving.                                                                                                                                           |
| `list_teams`                | Teams, members, specializations, speeds, days off, and their projects.                                                                                                                     |
| `list_trackers`             | Trackers with their headline reading and when they were last refreshed.                                                                                                                    |
| `get_tracker`               | One tracker: status per specialization, deadlines, teams, epics with their plan mapping and totals, and the daily samples (buffer history).                                                |
| `get_tracker_issues`        | Every Jira task with a browse link, classified as `matched`, `added_scope`, `unmapped`, `untracked` or `nice_to_have`.                                                                     |
| `get_tracker_scope_changes` | Postmortem facts: added scope by specialization, unmatched Jira work, plan tasks Jira never got, estimate drift, epics left out, first and last buffer sample - all with Jira links.       |
| `get_current_view`          | What the window is showing.                                                                                                                                                                |

**View** (always available when on)

`open_page` (dashboard, team, tracking), `open_project`, `open_tracker`,
`select_tracker_teams` and `set_plan_view`. The last two are saved with the
data - a tracker's team selection and a plan's view mode live there in the app
too - but they only change how things are shown, so they don't need **Allow
changes**.

**Write** (only with **Allow changes**)

`create_project`, `copy_project`, `update_project` (name, start date, buffer,
note, scheduling mode), `run_plan`, `add_epic`, `add_task`, `update_task`
(including `excluded` to skip a task), `set_member_off_days` (add, remove or
replace), `add_team_member`, `update_team_member`, `set_member_start`,
`set_team_inclusion` and `add_helper`.

Nothing can be deleted over MCP - no projects, teams, people, trackers, epics or
tasks. There is no undo in the app, so to try something out ask the client to
`copy_project` first. A stored plan does not update itself: after a change the
write tools say which plans want `run_plan`. Each change shows a toast in the
window ("AI assistant: …").

## What it can't do

- **Reach Jira.** Tracker data is as of the last refresh in the app. There is
  no refresh tool, because refreshing needs the Jira credentials, and no tool
  writes to Jira: date write-back stays behind its preview and confirmation in
  the app.
- **See your Jira credentials.** They live in the window's own storage and no
  tool reads them.
- **Run in a browser tab.** The endpoint is the Mac app's; in a browser the
  About panel shows no MCP section.

## How it works

```
 MCP client ──HTTP POST /mcp──▶ Electron main process ──IPC──▶ window (renderer)
 (Claude Code)  Bearer token     apps/desktop/electron/          apps/web/src/mcp/
                                 mcpServer.ts, mcpGuard.ts,      McpBridge.tsx
                                 mcpHost.ts                      runs the tool on the
                                 protocol: @planner/mcp          live store, dispatches
                                                                 its actions
```

- **`packages/mcp`** is pure, like `core`: the JSON-RPC handling (`initialize`,
  `ping`, `tools/list`, `tools/call`), the tool catalogue with JSON schemas -
  which double as the argument validator - and every tool. A read tool is a
  function of `AppState`; a write tool returns the **typed store actions** a
  click would dispatch. No SDK: the protocol subset is a few hundred lines, and
  the project hand-writes its guards.
- **The main process** holds the socket, the token and the switches, lists
  tools from the catalogue, and relays each call to a window as `{ name, args }`.
  It never answers a call itself.
- **The window** runs the tool against its store and dispatches the actions. The
  edit is then diffed, stamped with the HLC, written to SQLite and pushed to the
  sync server exactly like a click, so it syncs and merges last-write-wins like
  any other. The reply waits until the store has taken the change, so a
  client's next call reads what it wrote.

Transport is the stateless part of Streamable HTTP: one JSON-RPC message per
POST, one JSON reply (202 for a notification), no sessions, no server-sent
events (`GET` gets 405). Protocol versions 2024-11-05 to 2025-11-25 are
accepted.

## Security

| Rule                      | Why                                                                                                                                          |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Listens on 127.0.0.1 only | Not reachable from the network.                                                                                                              |
| `Host` must be loopback   | Defeats DNS rebinding.                                                                                                                       |
| Any `Origin` → 403        | Browsers send one on every POST; MCP clients don't. No web page can use the endpoint, even one served from localhost.                        |
| Bearer token              | 32 random bytes, compared in constant time. Keeps out other programs and other accounts on the Mac, which can open a loopback socket too.    |
| Token file is 0600        | `mcp.json` next to the database, readable by you only. Settings and token are per Mac: never in `AppState`, never synced, never in a backup. |
| Two switches, both off    | Connecting and changing are separate choices. Write tools aren't even listed while changes are off, and the window refuses them too.         |

The endpoint is separate from the sync server on port 5191 and does not go
through `apps/server/src/access.ts`; its rules are stricter because it has no
page of its own to let in.

## Configuration

- `PLANNER_MCP_PORT` - listen on another port (default 5192, or `port` in
  `mcp.json`). A second Planner (say a development build next to the installed
  app) finds the port taken and says so in the About panel.
- Settings live in `~/Library/Application Support/Planner/mcp.json`
  (`PLANNER_DATA_DIR` moves it with the database).

## Development

```bash
pnpm --filter @planner/mcp test            # protocol, schemas, every tool
pnpm --filter @planner/desktop test        # guard, settings, HTTP endpoint
pnpm --filter @planner/web test -- mcp     # the bridge and install commands
```

To try it end to end without touching your own data:

```bash
PLANNER_DATA_DIR=/tmp/planner-mcp PLANNER_SHARE=0 PLANNER_MCP_PORT=5199 pnpm dev:desktop
```

Turn it on in About, copy the Claude Code command, change the port in it if
you set one, and run it. `claude mcp list` should show `planner` connected.
