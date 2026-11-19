/**
 * Schema and migrations.
 *
 * Every synced table carries the same three sync columns:
 *   hlc      TEXT  — the stamp of the last edit that won for this row
 *   deleted  INTEGER — tombstone flag; the row stays so offline peers learn it went
 *   dirty    INTEGER — client-side only: this row has an edit not yet acked
 *
 * Child collections that are meaningless apart from their parent (a member's
 * off-days, a task's dependsOn, an epic's assigned members) are stored as JSON
 * on the parent row rather than as tables. They are replaced wholesale when the
 * parent row wins a merge — see the note in @planner/contracts/entities.
 *
 * Migrations are append-only and driven by SQLite's `user_version`. Never edit a
 * shipped migration: a device that has been offline since the last release will
 * replay exactly these statements in order.
 */
import type { SqliteDriver } from "./driver";

export interface Migration {
  version: number;
  name: string;
  up: string;
}

const V1 = `
CREATE TABLE projects (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL DEFAULT '',
  start_date       TEXT NOT NULL DEFAULT '',
  note             TEXT,
  title_color      TEXT,
  plan_view_mode   TEXT NOT NULL DEFAULT 'person',
  plan_mode        TEXT,
  plan_lookahead   INTEGER,
  buffer           REAL,
  member_starts    TEXT NOT NULL DEFAULT '{}',
  position         INTEGER NOT NULL DEFAULT 0,
  hlc              TEXT NOT NULL,
  deleted          INTEGER NOT NULL DEFAULT 0,
  dirty            INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE epics (
  id                   TEXT PRIMARY KEY,
  project_id           TEXT NOT NULL,
  name                 TEXT NOT NULL DEFAULT '',
  depends_on           TEXT NOT NULL DEFAULT '[]',
  assigned_member_ids  TEXT NOT NULL DEFAULT '[]',
  position             INTEGER NOT NULL DEFAULT 0,
  hlc                  TEXT NOT NULL,
  deleted              INTEGER NOT NULL DEFAULT 0,
  dirty                INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_epics_project ON epics(project_id);

CREATE TABLE tasks (
  id              TEXT PRIMARY KEY,
  epic_id         TEXT NOT NULL,
  project_id      TEXT NOT NULL,
  name            TEXT NOT NULL DEFAULT '',
  estimate_days   REAL NOT NULL DEFAULT 0,
  specialization  TEXT NOT NULL DEFAULT '',
  excluded        INTEGER NOT NULL DEFAULT 0,
  depends_on      TEXT NOT NULL DEFAULT '[]',
  position        INTEGER NOT NULL DEFAULT 0,
  hlc             TEXT NOT NULL,
  deleted         INTEGER NOT NULL DEFAULT 0,
  dirty           INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_tasks_epic ON tasks(epic_id);
CREATE INDEX idx_tasks_project ON tasks(project_id);

CREATE TABLE helpers (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  name            TEXT NOT NULL DEFAULT '',
  specialization  TEXT NOT NULL DEFAULT '',
  speed           REAL NOT NULL DEFAULT 1,
  available_from  TEXT NOT NULL DEFAULT '',
  available_to    TEXT NOT NULL DEFAULT '',
  off_days        TEXT NOT NULL DEFAULT '[]',
  position        INTEGER NOT NULL DEFAULT 0,
  hlc             TEXT NOT NULL,
  deleted         INTEGER NOT NULL DEFAULT 0,
  dirty           INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_helpers_project ON helpers(project_id);

-- id is the synthetic "<projectId>:<teamId>" so the pair is the identity.
CREATE TABLE team_inclusions (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  team_id         TEXT NOT NULL,
  epic_ids        TEXT,
  exclusive       INTEGER,
  available_from  TEXT,
  available_to    TEXT,
  velocity        REAL,
  position        INTEGER NOT NULL DEFAULT 0,
  hlc             TEXT NOT NULL,
  deleted         INTEGER NOT NULL DEFAULT 0,
  dirty           INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_inclusions_project ON team_inclusions(project_id);

CREATE TABLE teams (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL DEFAULT '',
  position  INTEGER NOT NULL DEFAULT 0,
  hlc       TEXT NOT NULL,
  deleted   INTEGER NOT NULL DEFAULT 0,
  dirty     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE members (
  id              TEXT PRIMARY KEY,
  team_id         TEXT NOT NULL,
  name            TEXT NOT NULL DEFAULT '',
  specialization  TEXT NOT NULL DEFAULT '',
  speed           REAL,
  off_days        TEXT NOT NULL DEFAULT '[]',
  position        INTEGER NOT NULL DEFAULT 0,
  hlc             TEXT NOT NULL,
  deleted         INTEGER NOT NULL DEFAULT 0,
  dirty           INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_members_team ON members(team_id);

-- A plan is derived output, regenerable by re-running the scheduler. It syncs
-- as one opaque row per project so a phone sees the plan its Mac produced
-- without having to re-run the engine.
CREATE TABLE plans (
  id        TEXT PRIMARY KEY,   -- == project id
  payload   TEXT,               -- JSON Plan, null when the project has no plan
  hlc       TEXT NOT NULL,
  deleted   INTEGER NOT NULL DEFAULT 0,
  dirty     INTEGER NOT NULL DEFAULT 0
);

-- The durable stream. On the server this is what clients pull from; on a client
-- it is the outbox of edits not yet acked (rows are pruned once acked).
CREATE TABLE oplog (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  entity    TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  hlc       TEXT NOT NULL,
  deleted   INTEGER NOT NULL DEFAULT 0,
  data      TEXT,
  origin    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_oplog_entity ON oplog(entity, entity_id);

CREATE TABLE sync_meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
`;

// Trackers arrived after the first release, so they are a second migration
// rather than an edit to V1 — a device offline since then replays V1 and V2 in
// order and lands on exactly the schema a fresh install gets.
//
// `snapshot` is the one genuinely large column in the database (a busy
// initiative serialises to a few hundred KB), and it still lives on the tracker
// row: it is derived output of the last refresh, replaced wholesale, and never
// merged field by field — the same argument that keeps a plan one opaque row.
const V2 = `
CREATE TABLE trackers (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL DEFAULT '',
  initiative_url TEXT NOT NULL DEFAULT '',
  initiative_key TEXT NOT NULL DEFAULT '',
  base_url       TEXT NOT NULL DEFAULT '',
  project_id     TEXT,
  hours_per_day  REAL,
  epic_map       TEXT NOT NULL DEFAULT '{}',
  snapshot       TEXT,
  samples        TEXT NOT NULL DEFAULT '[]',
  sprint_draft   TEXT,
  position       INTEGER NOT NULL DEFAULT 0,
  hlc            TEXT NOT NULL,
  deleted        INTEGER NOT NULL DEFAULT 0,
  dirty          INTEGER NOT NULL DEFAULT 0
);
`;

// Task-level Jira comparison supersedes epic-name comparison. Keep the old
// epic_map for backward compatibility; refreshed trackers gradually populate
// task_map without invalidating devices that have not upgraded yet.
const V3 = `
ALTER TABLE trackers
ADD COLUMN task_map TEXT NOT NULL DEFAULT '{}';
`;

// A tracker's deadlines — project end date, end of development, and which
// specializations are end-of-project work — as one JSON object. Nullable, so
// every existing tracker keeps reading exactly as it did: absent means "the
// plan's own end date, no end phase".
const V4 = `
ALTER TABLE trackers
ADD COLUMN deadlines TEXT;
`;

// Jira issues counted as scope added to the plan, keyed by issue with the
// specialization that does each. Stored apart from task_map, which stays a pure
// issue -> plan task map. NOT NULL with '{}', like task_map: an empty map and
// no map are the same thing.
const V5 = `
ALTER TABLE trackers
ADD COLUMN added_scope TEXT NOT NULL DEFAULT '{}';
`;

// Jira epics a tracker leaves out as another team's work, as a JSON array of
// epic keys. NOT NULL with '[]': none untracked and no list are the same.
const V6 = `
ALTER TABLE trackers
ADD COLUMN untracked_epics TEXT NOT NULL DEFAULT '[]';
`;

// Which teams a tracker reads, as a JSON array of team ids, and teams set by
// hand on Jira tasks, as a JSON object of issue key -> team id. NOT NULL with
// '[]' / '{}': every team and none set are the same as no value at all.
const V7 = `
ALTER TABLE trackers
ADD COLUMN view_teams TEXT NOT NULL DEFAULT '[]';
ALTER TABLE trackers
ADD COLUMN task_teams TEXT NOT NULL DEFAULT '{}';
`;

// Teams imported from Jira: where each came from (site, Atlassian team id and
// name, last sync) as one nullable JSON object, and each imported person's Jira
// account id. Both nullable, so every existing team and member reads exactly as
// before: absent means "made by hand".
const V8 = `
ALTER TABLE teams
ADD COLUMN jira TEXT;
ALTER TABLE members
ADD COLUMN jira_account_id TEXT;
`;

// Jira epics a tracker follows as nice-to-have work, on top of the plan, as a
// JSON array of epic keys. NOT NULL with '[]', like untracked_epics.
const V9 = `
ALTER TABLE trackers
ADD COLUMN nice_to_have_epics TEXT NOT NULL DEFAULT '[]';
`;

// A project's timeline markers (named dates such as an alpha gate) as a JSON
// array, and whether the timelines hide them. NOT NULL with '[]': no markers
// and an empty list are the same. hide_markers is nullable: absent = shown.
const V10 = `
ALTER TABLE projects
ADD COLUMN markers TEXT NOT NULL DEFAULT '[]';
ALTER TABLE projects
ADD COLUMN hide_markers INTEGER;
`;

export const MIGRATIONS: Migration[] = [
  { version: 1, name: "initial", up: V1 },
  { version: 2, name: "trackers", up: V2 },
  { version: 3, name: "tracker-task-map", up: V3 },
  { version: 4, name: "tracker-deadlines", up: V4 },
  { version: 5, name: "tracker-added-scope", up: V5 },
  { version: 6, name: "tracker-untracked-epics", up: V6 },
  { version: 7, name: "tracker-teams", up: V7 },
  { version: 8, name: "jira-teams", up: V8 },
  { version: 9, name: "tracker-nice-to-have-epics", up: V9 },
  { version: 10, name: "project-markers", up: V10 },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

/** Bring a database up to SCHEMA_VERSION. Safe to call on every open. */
export function migrate(db: SqliteDriver): number {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  const row = db.get<{ user_version: number }>("PRAGMA user_version;");
  let current = Number(row?.user_version ?? 0);

  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.transaction(() => {
      db.exec(m.up);
      // PRAGMA can't be parameterised, and m.version is a literal from this file.
      db.exec(`PRAGMA user_version = ${m.version};`);
    });
    current = m.version;
  }
  return current;
}

/** Read a value from sync_meta. */
export function getMeta(db: SqliteDriver, key: string): string | null {
  const row = db.get<{ v: string }>("SELECT v FROM sync_meta WHERE k = ?", [
    key,
  ]);
  return row?.v ?? null;
}

export function setMeta(db: SqliteDriver, key: string, value: string): void {
  db.run(
    "INSERT INTO sync_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
    [key, value],
  );
}
