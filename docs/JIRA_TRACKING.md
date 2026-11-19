# Tracking a Jira initiative

The **Tracking** tab links a Jira initiative to one of your plans and answers
the question you actually want answered every few days: _are we still on
schedule, and how much of the buffer have we spent?_

It also lets you lay out the next sprint against today's reality rather than
against dates the plan set months ago.

The design record for all of this is [JIRA_TRACKING.html](JIRA_TRACKING.html).

## What you need first

Planner talks to Jira with **your own Atlassian API token**:

1. Go to <https://id.atlassian.com/manage-profile/security/api-tokens> →
   **Security → API tokens → Create API token**.
2. In Planner, open **Tracking → Connect Jira** and fill in your Jira URL
   (`https://your-company.atlassian.net`), your Atlassian email, and the token.
3. Press **Test connection**. It should greet you by name.

The token is stored **on that device only** — in `localStorage`, never in the
app's database. It is not synced to your other machines and never appears in a
JSON export. Set it up once per device.

### One catch: a browser tab cannot call Jira

Jira Cloud sends no CORS headers, so a plain web page is not allowed to call it
at all. Planner works around this in the only two places it can:

| Where you run Planner              | How Refresh works                                                                       |
| ---------------------------------- | --------------------------------------------------------------------------------------- |
| **The Mac app**                    | Electron's main process makes the request. Nothing to configure.                        |
| **A browser, with a sync server**  | The request goes through the server's `/api/jira` proxy.                                |
| **A browser, with no sync server** | Refresh is unavailable. Existing trackers and their last synced snapshot still display. |

The proxy forwards your `Authorization` header and keeps nothing. It only talks
to `*.atlassian.net` (or the host named by `PLANNER_JIRA_HOST`) and only to
`/rest/api/3/` and `/rest/agile/1.0/` paths.

Writing to Jira is **off** on the server unless the deployer sets
`PLANNER_JIRA_WRITES=1`, and off in the app unless you tick the box in Jira
settings.

### Running it in development

`pnpm dev:web` on its own has no route to Jira, and the app will say so rather
than let you type a token that cannot go anywhere. Pick one of these.

**A Vite dev proxy — one Jira site, no server.** Put this in `apps/web/.env`
(git-ignored) and restart the dev server:

```
VITE_JIRA_DEV_TARGET=https://your-company.atlassian.net
```

**The sync server — several Jira sites, same path as production.** The site is
read from each tracker, so this is the one to use if you track more than one
Jira:

```bash
pnpm dev:server                                        # add PLANNER_JIRA_WRITES=1 to allow write-back
VITE_SYNC_URL=ws://localhost:5191/ws pnpm dev:web
```

Either way the Jira settings panel tells you which one is in use: it reads
"Refresh runs via the Vite dev proxy" or "via the Planner sync server".

The Mac app needs none of this — `pnpm dev:desktop`, or the packaged app, calls
Jira from Electron's main process where CORS does not apply.

## Setting up a tracker

Paste an initiative link into **Track a Jira initiative**. Any of these work:

```
https://your-company.atlassian.net/browse/ABC-123
https://your-company.atlassian.net/jira/software/c/projects/ABC/issues/ABC-123
https://your-company.atlassian.net/jira/software/c/projects/ABC/boards/551?selectedIssue=ABC-123
ABC-123
```

Then press **Refresh**. Planner reads the initiative, the epics under it, and
every epic's child issues with their time tracking. Epics are found by `parent`,
falling back to the "Parent Link" field and then to the _initiates_ issue link,
so both team-managed and company-managed projects work.

Finally pick a **baseline plan** — one of your Planner projects. Jira's child
issues are matched to Planner tasks by name automatically, regardless of which
epic each side puts them under; the **Plan task** column shows the match. There
is nothing to pick for a matched task.

A Jira task that matches no plan task is **added scope**: work your team took
on after the plan was made. Its specialization is read from its tags — a Jira
label ("backend", "qa"), else a bracketed tag in its summary ("[QA] …") — using
the same vocabulary as building a plan from Jira, including this device's tag
mappings. A task whose tags name no specialization (or name two) shows as
**Unmapped** with a specialization picker; pick one and it becomes added scope.
An unmapped task counts for nothing until then. A specialization once set, by
its tags or by you, is kept on later refreshes; change it with the same picker.

Added scope counts like a plan task sized by its Jira estimate: planned, earned
when done, and scheduled after the planned work wherever that specialization
has time. The promised dates stay the baseline's, so added scope uses up
buffer, or makes you late, instead of quietly moving the end date. An added
task with no Jira estimate counts as 0 days and is flagged in red until it has
one.

Each Jira epic's row says how the tracker follows it:

- **Track it** — work the plan must deliver. The default.
- **Nice to have** — work you would like to get to on top of what you have to
  do. Its tasks stay in this table, matched and given specializations like any
  other, with their planned and earned days. But the status, the buffer and
  the history leave them out, so nice-to-have work never makes the must-do
  work look late. The **Work left, by person** planner can lay it out too (see
  below). These epics sort after the must-do work.
- **Don't track it (another team)** — everything under it is left out,
  including tasks that only appear in a later refresh, and none of them is
  matched or turned into added scope. These epics sort to the bottom.

Neither kind is moved in **Jira order**. When several teams share an
initiative, each task's team comes from Jira (see below), so another team's
tasks drop out of a team's reading.

**Refresh never changes the baseline's estimates.** The baseline is what
progress is measured against, so a new or changed estimate in Jira only shows
up as "N plan tasks have a different estimate in Jira". **Review estimates…**
lists each one with its plan estimate beside Jira's. Untick any the plan should
keep, then update the rest. A skipped task (one imported with no estimate)
is un-skipped when its estimate is copied. This edits the Planner project, not
Jira, and the plan's dates move with it.

## Rebuilding the plan from Jira

When the plan and the initiative have drifted apart — epics renamed or turned
into milestones, tasks moved between them — matching by name stops working and
the status reads as far behind. Instead of re-mapping by hand, build a fresh
plan from Jira:

- On a tracker, press **New plan from Jira** (it uses the last snapshot), or
- on **Projects**, press **From Jira initiative** and paste the link.

Every child issue becomes a task sized by its **original estimate**, falling
back to logged + remaining time. **Status is ignored**, so finished work is
planned too; that is what lets the tracker say how far along you are. An issue
with no estimate at all comes in as a skipped 0-day task for you to fill in.

People, helpers, start dates, plan mode and buffer are copied from the project
you pick under **Copy people from** (the tracker's current baseline by
default). Epic owners and epic-scoped teams are not copied, because the epics
no longer correspond. Each task's specialization comes from, in order: the
matching task in the old plan, a specialization named in the issue summary
("Wallet QA pass"), the Jira assignee's specialization, the rest of its epic,
then the default you choose.

Before anything is created, the dialog shows the current plan and the rebuilt
one side by side: estimate, finish without and with buffer, and today's status.
By default the new project gets **a new tracker** with an exact issue-to-task
map, so the old tracker and its history stay untouched. You can instead switch
an existing tracker's baseline to it. To see how many people the rebuilt plan
needs, copy the project and add helpers or teams until the promised finish
fits.

## Adding teams from Jira

The Teams tab can bring in the teams from Jira's own **Teams** tab (Atlassian's
Teams directory), with the people already on them there, next to the teams you
made by hand. Press **Add from Jira…** and the list loads straight away.

The Teams directory belongs to your Atlassian **organization**, so Planner
looks up the organization ID from your Jira site the first time and remembers
it on this device. If that lookup is not allowed for your account, the dialog
asks for it: open admin.atlassian.com and paste either the ID or the whole
address (the ID is the part after `/o/`).

Tick a team to load its members, untick anyone who should not come along, and
fill in each person's specialization. The directory has no such field, so
Planner copies it from a same-named person already in Planner and leaves the
rest blank for you.

Two rules keep the roster sane:

- **Nobody is added twice.** Someone already on any Planner team is shown but
  skipped. If you tick two teams that share a person, the dialog warns you;
  they join the first one.
- **Importing again updates.** A team you added before shows "Updates …" and
  only brings in people who are new; names, specializations, speeds and days
  off you set here are kept.

Once added, a Jira team is an ordinary team marked **From Jira**: set its days
off in the availability grid and its timeline per project (the team's
availability window and velocity) exactly as for any other team.

Atlassian's Teams REST API is reportedly open only to accounts with
organization-level access, so when it refuses, Planner falls back to routes
an ordinary user can read:

- **The team list:** the Teams API for your site, then for the whole
  organization, then Atlassian's Teams GraphQL search.
- **A team's members:** the Teams API, then — for a team synced from a Jira
  group — that group's members (needs only _Browse users and groups_), then
  the Teams GraphQL members query.

If Atlassian refuses every roster route — its Teams service does this for
some accounts, even ones that can see the team in Jira — Planner falls back
to **the people assigned to the team's Jira issues** (issues whose Team is
that team, updated in the last 180 days), with how many each has. The dialog
marks this clearly as _not the roster_ and says why the roster was refused:
untick anyone who isn't on the team, and add anyone missing by hand
afterwards. The team itself still comes from the Teams tab.

If even that fails, the dialog shows each route's reason. The GraphQL
Teams fields are beta, so if Atlassian changes them the message will say
which field it no longer knows.

The Mac app and the sync server allow exactly these reads and nothing more:
the team list, one team's member list, and three fixed GraphQL queries (the
organization ID lookup, the team search and a team's members), each checked
against its exact shape. Changing a team or its members is not possible
through Planner.

## Deadlines and end-of-project work (QA)

The **Deadlines** section on a tracker shows the three dates progress is judged
against. Each is filled in from the baseline plan. Pick **Custom** to set it
yourself, and **From the plan** to go back.

| Date                   | From the plan                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------- |
| **Start date**         | The project's start date. A custom one re-plans the project from that day.            |
| **End of development** | When the specializations ticked under **Counts as development** finish (with buffer). |
| **End date**           | The plan's finish with buffer.                                                        |

**Custom dates re-time development.** Once a custom start date or a custom
end of development is set, the scheduler's dates stop being the measuring
stick. Development gets the window from the start date to the end of
development, buffer included. The finish without buffer is that window minus
the project's buffer share: a 60-working-day window with a 20% buffer puts it
50 days in, and the last 10 are the buffer. "Planned so far" is the
development work at an even pace up to that finish, in team working days. The
status then says **Re-timed to your dates**. With no custom date set, the
tracker measures against the scheduler's own plan as before.

Your dates set the pace, not the team's size. The projected finish is never
earlier than what the scheduler says the project's real people can do from
where the work stands, so a baseline with fewer people reads later even with
the dates unchanged. That is what makes "copy the project and remove a team"
answer "can one team still make these dates?". When that floor decides the
reading, "Planned so far" follows it too: it becomes what those people needed
finished by today to be done by the finish without buffer. That way the
numbers never show more done than expected next to a status that says behind.

Only work the plan can schedule counts as progress. A finished task whose
specialization nobody on the baseline has is not in the plan total, so it earns
nothing; that specialization shows as unscheduled instead.

**The plan is always re-run.** Both the plan with buffer and the one without
it are calculated from the project's current tasks, estimates, people and days
off, so the finish without buffer is never later than the finish with it. If
the project page's plan is out of date (changed since **Run Plan** was last
pressed), the status says so with both finish dates.

**Counts as development** lists every specialization, all ticked by default.
Untick end-of-project work, usually QA. If a specialization is named like QA, QC
or Test, the tracker offers a one-click **Treat QA as end-of-project work**.
Until you untick something, the tracker reads exactly as it always has.

The scheduler plans QA tasks as soon as a QA person is free, often in the first
weeks. Measured against that schedule, QA would read as behind for the whole
project. With QA ticked:

- **The headline covers development only**, judged against the end of
  development, e.g. "Development ends 2026-12-11 · 8 days to spare". If the
  plan itself finishes development after that date, it says so even when the
  team is on pace. That means the plan does not leave QA its window.
- **QA gets its own schedule, counted back from the end date.** Its tasks are
  laid out as late as possible, the last one ending on the end date, with each
  task stretched by the project's buffer. That tells you when QA **must start**,
  and the date of every QA task (open "QA schedule" under the table). QA's
  finished Jira tasks are measured against that schedule the same way
  development is measured against its plan, so the row reads "N days ahead" or
  "N days behind". Before the first QA task is due, the lead is the time left
  before it must start.
- **QA's buffer is the gap to the same schedule without the buffer**, which is
  the very latest QA could start. Falling behind the buffered schedule reads
  "using X of Y buffer days"; falling behind the unbuffered one too means QA is
  **late for the end date**. If QA must start before the end of development,
  the row says so.
- **Tasks without an estimate** are counted on each row ("3 tasks without an
  estimate — not counted yet"). A specialization with none estimated at all
  reads **No estimates yet** rather than a misleading number.

## Reading the status

```
▼ 5 days behind the finish without buffer · using 5 of 20 buffer days (25%)
  End date 2026-12-25 · 15 days to spare
```

Planner re-runs the scheduler on your baseline project with the buffer set to
**zero** and measures against that. That is the point: the buffer is what you
are trying to protect, so the comparison has to be against the plan without it.

- **Planned so far** — plan days the unbuffered plan expected finished by today.
- **Earned** — plan days Jira says are finished. Each mapped Planner task
  contributes its estimate only when the matching Jira issue is in Jira's
  **Done** status category. Epic names and time-logging progress do not affect
  this number.
- **Variance** — working days ahead (+) or behind (−). It compares _progress_,
  not dates, so tasks finishing in a different order than planned is fine.
- **Using buffer** — how much of the gap between the unbuffered finish and the
  promised (buffered) finish has been eaten.

**By specialization.** Under the headline numbers, a table repeats the reading
for each specialization. Each row compares only that specialization's tasks
with its own part of the plan without buffer, using its own people's days off.
Adding everyone's work together would let a frontend running ahead hide QA
falling behind, and would pair one specialization's finish date with an average
of everyone's delay. So the headline is not a pooled number: the development
specialization with the least to spare **is** the headline. Its variance,
buffer, projected finish and how late it lands are what the status line says,
and the panel names it. **Planned so far** and **Earned** still add everyone's
work together.

Each row reads in one of three ways. Green is how many days it is ahead of the
plan without buffer. Orange is how much of its own buffer it is using, how much
is left and the share used. Red is how many days it lands after its deadline,
with the whole buffer used. A specialization whose first task hasn't started
yet reads **Not started yet**, not "behind". One that nobody on the plan can do
is flagged. End-phase work (QA) is judged against the end date and never sets
development's headline.

**When it finishes, counted by people.** When a development specialization
is behind its plan, its finish is also counted by its people, not only by the
plan's curve. Starting tomorrow, each person works through the work left at
their own speed, inside their own dates, minus days off, and the day they get
through it is the projected finish. So 3 plan days left over after the
deadline with 3 developers is 1 day late, not 3. This is the fastest the work
could go, so it only ever brings a finish earlier, and never earlier than the
finish without buffer: it can win back time the plan's pace lost, but it never
makes a row read ahead. The finish is a real date on either side of the
deadline, so moving the end of development changes the buffer and the days to
spare, never the projected finish itself. The row says so, either "9 plan days
won't fit before the end of development, split across its 3 people: 3 working
days after it" or "the work left is done by 2026-11-27, before the end of
development". End-phase work (QA) keeps its own schedule and is only counted by
people once it would miss the end date.

**Several teams on one initiative.** When the tracker's tasks belong to more
than one team, a **Teams in this reading** box sits above Status. It lists the
teams found in Jira, with how many tasks each has. Tick one team to see it on
its own, or several to merge them. Ticking every team is the usual reading.
For a selection, every number is those teams' alone:

- **Their Jira tasks.** A task's team is, in order:
  1. the one you set in the **Team** column of Task comparison;
  2. its Jira **Team** field, which a refresh fetches;
  3. its epic's Jira **Team** field, since an epic is usually one team's work;
  4. the Planner team of its Jira assignee, matched on name;
  5. the team most of its epic's tasks belong to.

  A task with no team at all is left out, and the Status panel says how many,
  so you can set one.

  Task comparison names each epic's team beside its key (every team in it,
  most tasks first, when an epic is mixed). With a selection, it shows only
  the selected teams' tasks and hides epics left with none. Tasks with no
  team stay visible, so you can give them one.

- **The plan work those tasks map to.** Plan tasks no Jira task of theirs maps
  to are left out.
- **Their people.** These are the people of the Planner team with the same name
  ("Stars" in Jira, "Stars" in Planner). They decide the plan without buffer,
  the capacity used for how late, and the "÷ people" of the review queue.
  Helpers belong to no team, so they are left out. If no Planner team has that
  name, everyone on the project counts, and the panel says so.

Dates you set on the tracker still apply. Dates left to the plan come from the
selected teams' part of it. The selection is saved on the tracker and syncs,
and history samples are taken with whatever selection is set at refresh.
Snapshots taken before the Team field was fetched have no Jira teams: refresh
the tracker once.

**Waiting to be closed.** Only Done counts as earned, so work sitting in review
or ready is invisible to the reading. The Status panel lists open tasks whose
status name says review or ready (not "Ready for development"), by status, with
their plan days. It also shows what closing all of them today would do to the
projected finish. Each specialization row shows its own share of that queue,
and how its row would read with it closed.

To read handed-on work as finished, tick **Count tasks past To Do and In
Progress as done** in the Status panel. Every open task in Jira's In Progress
category whose status is not work in hand ("In Progress", "In Development",
"Blocked", "On Hold") or not begun ("Ready for development") then counts as
done: in review, QA, testing, ready to deploy. Status, buffer and the
specialization rows all follow it. It is a view, not a setting: it starts
unticked each time, and refresh history samples never use it.

Every count of days here is in **team working days**, not calendar weekdays.
Weekends don't count. A day when everyone on the project is off (a Christmas
break entered as days off) counts as nothing, and a day when half the people are
off counts as half. Without this, a plan that pauses for a three-week holiday
would make a team look three weeks ahead of it. A projected finish would also
land in the middle of the break. People only count while they are on the
project, so a helper whose window has ended doesn't turn every later day into a
half day.

Every headline names the date it is measured against. Progress is compared
with the **finish without buffer**. The buffer then sits between that and the
**end date** (the finish with buffer), and a second line under the headline says
where you stand against the end date, e.g. "End date 2026-12-25 · 35 days to
spare".

| Status                                                                 | Meaning                                                    |
| ---------------------------------------------------------------------- | ---------------------------------------------------------- |
| **N days ahead of the finish without buffer**                          | More done than the plan expected by now; buffer untouched. |
| **On time for the finish without buffer**                              | Within half a day either way.                              |
| **N days behind the finish without buffer · using X of Y buffer days** | Behind, but the end date still holds.                      |
| **Buffer used up · N days late for the end date**                      | Past the buffer. The end date is at risk.                  |

Every refresh also records a **sample**, so the History panel shows whether the
buffer is going faster this week than last. That trend is the reason to check
every few days rather than once at the end.

## Work left, by person

At the bottom of a tracker, **Work left, by person** plans everything still
open forward from today. It answers who should pick up which task next, when
each person runs out of work, and when all of it is done.

- **Only To Do and In Progress.** Tasks Jira has finished are gone, and so
  are tasks in review or ready to deploy: nobody needs to pick them up, and the
  **Left out** line counts them. Tick **Also plan tasks in review or ready to
  deploy** to plan them too (⏸), at their whole estimate, which is how the
  status still counts them until they are Done. A task counts as estimated
  when the plan or Jira gives it days; when the plan has none, Jira's estimate
  is used.
- **Nice-to-have work only on request.** Epics set to **Nice to have** are
  left out, as the status leaves them out. Tick **Also plan nice-to-have
  work** to lay them out on top of the must-do work; their tasks are tagged
  _nice to have_, and **Compared with the status above** counts their days as
  work the status doesn't have.
- **Jira tasks that aren't in the plan count too**, on Jira's estimate, so the
  finish covers all the work in the initiative. Their specialization comes from
  a label naming one, else a tag in the summary ("[Backend] Wallet API"), else
  their assignee's, else the one most of the planned tasks in the same Jira
  epic have. One with none of those is listed by key
  rather than guessed. Tasks in untracked epics are skipped.
- **From today, without buffer.** The same scheduler as the project plan hands
  the work out: specializations, speeds, days off, availability windows and
  dependencies all apply.
- **Work someone holds stays with them.** A task in progress in Jira (marked ▶)
  stays with its assignee for what Jira says is left of it (never more than its
  estimate). When Jira has nothing left on it, it has overrun its estimate, not
  finished, so it keeps its whole estimate. A task assigned in Jira but not started waits for its assignee,
  in its turn. Everything nobody holds goes to whoever would finish it soonest
  and is marked **suggested** (striped in the timeline). A Jira assignee is
  matched by Jira account, by full name, or by a short name ("Michał K" for
  "Michał Kowalski") when only one person fits.

**Compared with the status above** sets each specialization's finish here
beside the status table's projected finish, and says what accounts for any
gap: tasks in review or ready to deploy (planned here only when ticked, but
counted by the status until Done), Jira tasks not in the plan (the status
leaves them out until they have a specialization), Jira estimates for tasks the plan hasn't estimated,
work in progress Jira says is nearly done (the status counts its whole
estimate until Done), and the layout itself. Here each task goes to one
person; the status follows the plan's pace or shares the work evenly. End-phase
work (QA) is counted back from the end date in the status but starts as soon as
someone is free here, so the summary gives development's finish and the end
phase's apart.

Nothing open drops out of sight. A task with no estimate can't be laid out,
but the **Left out** line names it by key, and one in progress shows in its
assignee's **Now** column.

The table lists everyone on the project, each specialization together under
a heading of its own (the one that finishes last on top, and within it whoever
finishes last first). For each person it shows what they are on now, the
next task planned for them (assigned in Jira or suggested, and whether it is
in the plan), how much is left, and the day they are done. The timeline
below keeps the same order and fits the forecast to the panel's width, with a
label for every day once there is room. **+** and **−** zoom in and out, and
**Fit to width** goes back. A task that depends on one still in progress is
not held back until that one finishes, so read those with care.

## Planning a sprint

The **Sprint** section lists every open issue under the initiative, grouped by
epic. Tick the ones you intend to do next.

Each row gets an estimate (from Jira's remaining time, falling back to the
original estimate, then to the mapped plan epic's average task size), a person,
and a start date. The due date is computed with the same scheduler the plan
uses, so weekends, that person's days off and their speed all apply.

- **Auto-stack per person** chains each person's rows back to back.
- A row that ends after the sprint ends is flagged **Won't finish in sprint**.
- Someone booked past their capacity for the window is flagged under the table.
- The timeline draws the draft in colour with the baseline plan's bars for the
  same epics faded behind it, so drift from the original plan is visible.

If write-back is enabled, **Apply dates to Jira** shows a preview of exactly
which issues change and what their start and due dates become, and applies
nothing until you confirm. Only dates are written — never assignees, never
estimates. Issues whose dates already match are left alone.

## Troubleshooting

| What you see                                            | What it means                                                                                       |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| "Jira rejected your email and token"                    | The token is wrong, expired, or belongs to another account.                                         |
| "ABC-123 does not exist, or your account cannot see it" | Wrong key, or no permission on that project.                                                        |
| "Refreshing needs the Planner Mac app or a sync server" | A browser with no route to Jira. See [Running it in development](#running-it-in-development).       |
| "Jira is rate-limiting this account"                    | Too many refreshes at once. Wait a minute.                                                          |
| "Jira is unavailable (HTTP 502): Could not reach Jira…" | The request never reached Atlassian. The text after the colon names why (proxy, certificate, DNS).  |
| Jira epics table is empty                               | The initiative has no epics under it by `parent`, "Parent Link" or the _initiates_ link.            |
| Task comparison has unmatched rows                      | The names differ too much for a safe automatic match. Pick the corresponding Planner task manually. |
| Status says "Not comparable yet"                        | No baseline plan, no plan generated on it, or no epics mapped.                                      |
