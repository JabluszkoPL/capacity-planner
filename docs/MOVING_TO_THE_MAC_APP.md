# Moving your data from the browser to the Mac app

This guide is for someone who has been using Planner **0.1.x in a browser**
and now wants everything in the **Mac app**: projects, teams, Jira trackers
with their history, and the Jira connection.

It takes about five minutes. Nothing in the browser is deleted along the way,
so you can always go back.

## Why the data doesn't simply show up

A browser keeps Planner's data **per address**. A page opened at
`http://localhost:5190` (from `pnpm dev:web`) and one opened at
`http://localhost:5191` each have their own separate copy, even in the same
browser.

The Mac app keeps its own copy too. Its **Open in browser** button opens
`http://localhost:5191`, which is the app's data, not the copy in the browser
page you used before. So to the app, your old browser data does not exist
until you move it across once. After that the app and any browser connected to
it stay in sync on their own.

## What moves, and what doesn't

| Moves                                       | How                            |
| ------------------------------------------- | ------------------------------ |
| Projects, epics, tasks, plans               | Option A, B or C               |
| Teams, people, speeds, days off             | Option A, B or C               |
| Jira trackers, including their history      | Option A, B or C (app ≥ 0.1.4) |
| Jira site, email and hours per day          | Option B only                  |
| Jira API token                              | Option B, only if you tick it  |
| Remembered tag → specialization mappings    | Option B only                  |
| "Allow Planner to write dates back to Jira" | Never. Switch it on yourself   |

With option A or C you type the Jira connection into the app once (sidebar →
**Jira**). That takes under a minute.

## Before you start

1. **Install the latest Mac app** from the
   [releases page](https://github.com/JabluszkoPL/capacity-planner/releases/latest)
   (0.1.5 or newer). If you already have the app, click the version in its top
   bar and update from there.
2. **Open the Mac app once** and leave it running. It runs the server the
   browser will talk to.
3. **Find the browser page that holds your data**: the same browser and the
   same address you always used (for example `http://localhost:5190`). Check
   that your projects are there.
4. **Optional safety copy**: on that page, go to **Projects → Export…**, keep
   every project ticked, and click **Export _N_ projects**. You now have a JSON file you can
   always import again.

Don't clear that browser's site data or history until you have checked the
result in the app.

## Option A: connect the browser to the app (recommended)

This works with every 0.1.x version and moves projects, teams and trackers in
one go. Nothing is overwritten: the browser's data is merged into the app's
row by row.

1. In the Mac app, click **Settings** at the bottom of the sidebar and open
   **Sync & sharing**. Under **Sharing** it says `http://localhost:5191`. If there is also a note that **another Planner
   server** is running on this port, see [Troubleshooting](#troubleshooting)
   first.
2. In the **old browser page**, click the version in the top bar (0.2 and
   newer: **Settings** at the bottom of the sidebar, then **Sync & sharing**).
   The **About Planner** window opens.
3. Under **Sync**, type `localhost:5191` into **Sync server** and click
   **Connect**. The page reloads.
4. Open the window again. **Sync** should say _Connected and up to date_.
5. Look in the Mac app: your projects, teams and trackers are there. Trackers
   keep their history.
6. In the Mac app, click **Jira** at the bottom of the sidebar and enter your Jira site,
   email and API token. Your trackers can refresh again.

You can leave the browser page connected (it then stays in sync with the app)
or click **Disconnect**. Either way, from now on use the app, or its
**Open in browser** button.

> If the **Sync** section says _This page is served by a Planner server_, your
> page already is `http://localhost:5191`, served by `pnpm serve` or
> `pnpm dev`. That server uses the same database file as the app
> (`~/Library/Application Support/Planner/state.sqlite`) unless you changed
> `PLANNER_DB` or `PLANNER_DATA_DIR`. Stop the server (Ctrl+C in its terminal),
> quit and reopen the Mac app, and the data is already there.

## Option B: one backup file, including the Jira connection

This moves the Jira connection too, and optionally the API token. It needs the
browser page to be **0.1.4 or newer**: the **Backup and transfer** section must
be in its About window.

If the page comes from `pnpm dev:web`, update it first:

```bash
git pull
```

```bash
pnpm install
```

Restart `pnpm dev:web` and reload the page. Your data stays: it is stored in
the browser, not in the code.

Then:

1. In the **old browser page**, click the version in the top bar and scroll to
   **Backup and transfer** (0.2 and newer: **Settings** in the sidebar →
   **Backup**).
2. To bring the Jira API token, tick **Include the Jira API token**. Anyone
   holding the file can then use Jira as you, so treat the file like a
   password.
3. Click **Export everything**. A file named `planner-backup-<date>.json` lands
   in your Downloads folder.
4. In the **Mac app**, click **Settings** in the sidebar → **Backup** →
   **Import backup…**, and pick that file.
5. Check the preview: it lists how many projects, teams and trackers will be
   added and which Jira account comes with it. Leave **Use its Jira
   connection** ticked, then click **Import**.
6. If you exported without the token, the app tells you so. Add it in the top
   bar → **Jira**.
7. **Delete the backup file** if it contains the token.

## Option C: the dashboard export (older pages, no sync)

Use this when the old page has no **Backup and transfer** section and cannot
reach the app, for example when it is on another computer.

1. In the old page: **Projects → Export…**, keep every project ticked, and
   click **Export _N_ projects**.
2. Copy the file to the Mac if needed.
3. In the Mac app: **Projects → Import…** and pick the file.
4. Add the Jira connection: sidebar → **Jira**.

Trackers come along as long as the **app** is 0.1.4 or newer. Older versions
imported the projects but silently dropped the trackers.

## Check the result

- **Projects**: every project is there. The app may also have created a demo
  project (_Forecast demo_) on its first start; delete it if you don't want it.
- **Teams**: people, specializations and days off are as before.
- **Tracking**: every tracker is listed, and its **History** still shows past
  readings.
- **Jira**: the dot next to **Jira** in the sidebar is green, and **Refresh**
  on a tracker works.

## Troubleshooting

**"Open in browser" shows an old version of Planner, or the About window
mentions another Planner server.** Something else already holds port 5191,
usually `pnpm dev` or `pnpm serve` running in a terminal, and the app is
syncing with it instead of with its own server. Stop it (Ctrl+C), quit the Mac
app and open it again.

**The app's browser page is empty or only shows the demo.** That is the
different-address effect described [above](#why-the-data-doesnt-simply-show-up).
Move the data with option A, B or C. The page at `http://localhost:5191` shows
it as soon as the app has it.

**A project now appears twice, the second one named "… (imported)".** The same
file was imported twice (options B and C add projects rather than replace
them). Delete the copy you don't need. Option A never duplicates anything.

**Sync says _The server runs an incompatible version_.** The browser page is
too old for the app's server. Update the page (see option B) or use option C.

**Trackers are missing after an import.** The import ran in an app older than
0.1.4. Update the app and import the same file again. Projects that are
already there get a second copy, so delete the duplicates afterwards.

## Coming from the very first Planner (localStorage only)

The original browser-only Planner (before this project) has no sync. In it,
use **Export everything**, then in the Mac app go to **Projects → Import…** and
pick that file. It has no trackers or Jira connection to bring.
