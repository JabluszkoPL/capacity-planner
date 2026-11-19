/**
 * Shared data model for the Planner app.
 *
 * Defined here by T01. Every later task imports these types and none redefine
 * them — this file is the single contract for the app's data shapes.
 */

export type ID = string;

export interface TeamMember {
  id: ID;
  name: string;
  specialization: string;
  /** Work speed relative to estimates (1 = at estimate). Defaults to 1. */
  speed?: number;
  /**
   * The person's Jira account id, set when they were imported from a Jira
   * team. Lets a later "update from Jira" recognise them however they were
   * renamed here. Absent = added by hand.
   */
  jiraAccountId?: string;
}

/**
 * Where a team imported from Jira came from. Only the link back is kept —
 * the roster, specializations, speeds and days off are Planner's own and are
 * edited here exactly like a hand-made team's.
 */
export interface JiraTeamSource {
  /** Site origin, e.g. "https://acme.atlassian.net". */
  baseUrl: string;
  /** Atlassian organization id the team belongs to. */
  orgId?: string;
  /** Atlassian team id. Absent only on teams imported by name. */
  teamId?: string;
  /** The team's name in Jira, which may differ from its name here. */
  teamName: string;
  /** ISO datetime of the last import or update from Jira. */
  syncedAt: string;
}

/**
 * A per-project helper — an external person (or extra hand) brought in for a
 * single project. They work at `speed` relative to the team's estimate and are
 * only available within [availableFrom, availableTo].
 */
export interface Helper {
  id: ID;
  name: string;
  specialization: string;
  speed: number; // e.g. 0.6 = 60% as fast, so tasks take longer
  availableFrom: string; // ISO date
  availableTo: string; // ISO date
  /** Individual days this helper is off (ISO dates), e.g. Christmas holidays.
   *  Skipped by scheduling just like weekends. Absent = no days off. */
  offDays?: string[];
}

export interface OffDayMap {
  [memberId: string]: string[]; // ISO dates, e.g. "2026-08-03"
}

/**
 * A named group of team members. The app can hold many teams; a project decides
 * which teams participate and how (see {@link TeamInclusion}). Member ids are
 * globally unique across every team, so per-project maps keyed by member id
 * (memberStarts, epicAssignments) work regardless of which team a member is in.
 */
export interface Team {
  id: ID;
  name: string;
  members: TeamMember[];
  offDays: OffDayMap;
  /** Set when the team was imported from Jira. Absent = made by hand. */
  jira?: JiraTeamSource;
}

/**
 * How one team participates in one project. A project's `teamInclusions` lists
 * the participating teams; a team absent from the list does not participate.
 * (When `teamInclusions` itself is absent, *every* team participates fully —
 * the backward-compatible default.)
 *
 * The two constraints are combinable on the same team:
 *  - **Epic scope** (`epicIds`): the team's members only work these epics.
 *    `exclusive` then decides whether *other* teams are locked out of those
 *    epics ("only this team") or may still help ("this team focuses here").
 *  - **Time period** (`availableFrom`/`availableTo`): the team only works
 *    within that window, exactly like a helper's availability window.
 */
export interface TeamInclusion {
  teamId: ID;
  /** Restrict this team's members to these epics. Absent/empty = all epics. */
  epicIds?: ID[];
  /** With `epicIds` set: reserve those epics to this team (others locked out). */
  exclusive?: boolean;
  /** ISO date; team can't start before this. Absent = project start. */
  availableFrom?: string;
  /** ISO date; the whole of a task's span must finish by this. Absent = no end. */
  availableTo?: string;
  /**
   * Per-project velocity multiplier applied on top of each member's own `speed`
   * for this project only. `1` (or absent) = no change; `0.9` = this team works
   * at 90% of estimate here, `0.7` = 70%. Use it to model what happens when
   * several teams share a project (e.g. the original team drops to ~0.9 and an
   * added team runs at ~0.7). Effective speed = member.speed × velocity.
   */
  velocity?: number;
}

/**
 * Which schedule grid the project shows: one lane per person, one row per
 * task, or one row per epic (its earliest start to its latest finish). Stored
 * values a device doesn't recognise read back as "person" — see
 * `planViewModeOf`.
 */
export type PlanViewMode = "person" | "task" | "epic";

export interface TaskItem {
  id: ID;
  name: string;
  estimateDays: number; // may be fractional, e.g. 0.5
  specialization: string;
  excluded: boolean; // true = "skipped", stays in the list, ignored by scheduling
  /** Task ids that must finish before this task can start (same project). */
  dependsOn?: ID[];
}

export interface Epic {
  id: ID;
  name: string;
  tasks: TaskItem[];
  /** Epic ids that must fully finish before any task in this epic can start. */
  dependsOn?: ID[];
}

export interface Assignment {
  taskId: ID;
  taskName: string;
  epicId: ID;
  epicName: string;
  specialization: string;
  estimateDays: number;
  /**
   * Whole working days actually blocked out for this assignee — the effective
   * duration `estimateDays / speed` rounded *up* to whole days (min 1), since a
   * person can't split a day across tasks. The gap between this and the exact
   * `estimateDays / speed` is the slack captured in {@link Plan.roundingBufferDays}.
   */
  workDays: number;
  memberId: ID;
  memberName: string;
  start: string; // ISO date
  end: string; // ISO date
}

export interface UnassignedTask extends TaskItem {
  epicId: ID;
  epicName: string;
  reason: string;
}

export interface Plan {
  generatedAt: string; // ISO datetime
  assignments: Assignment[];
  unassigned: UnassignedTask[];
  /**
   * Total working days of slack gained by rounding each assignee's fractional
   * effective duration (`estimateDays / speed`) up to whole days. A 0.5-day
   * task blocked out as 1 day contributes 0.5; a 1.3-day task as 2 days
   * contributes 0.7. Summed across every assignment. Absent on plans generated
   * before this was tracked — treat as 0.
   */
  roundingBufferDays?: number;
}

export interface Project {
  id: ID;
  name: string;
  startDate: string; // ISO date
  /**
   * A free-text comment/annotation for this project, shown at the top of the
   * project page (before the plan). Handy when comparing several projects as
   * options — e.g. "This is the best option" or "Low risk". Absent = none.
   */
  note?: string;
  /**
   * CSS color for the project's title, used to colour-code options at a glance
   * (e.g. green = preferred, red = not real). A hex string, or absent for the
   * default text color.
   */
  titleColor?: string;
  epics: Epic[];
  plan: Plan | null;
  planViewMode: PlanViewMode;
  /**
   * How Run Plan schedules. "balanced" (default/absent) assigns each task in
   * list order to whoever finishes soonest. "smart" is worker-driven and
   * days-off-aware: the freed-est person picks the best-fitting task among the
   * next {@link planLookahead} ready ones, preferring work that finishes before
   * their own next break. See {@link PlanOptions} in lib/scheduling.
   */
  planMode?: "balanced" | "smart";
  /** Smart mode's lookahead window — how many upcoming tasks a freed worker may
   *  choose among. Absent = 5. */
  planLookahead?: number;
  /**
   * A safety buffer applied to *every* task's estimate before scheduling, as a
   * percentage (0–100). `20` stretches each estimate by 20% (a 5-day task is
   * planned as 6 days); `0`/absent = estimates used as-is. Lets you pad an whole
   * plan for uncertainty without editing individual task estimates.
   */
  buffer?: number;
  helpers?: Helper[]; // per-project external helpers
  /** Per-project start-date overrides for team members (ISO date). Absent =
   *  the member starts on the project start date. */
  memberStarts?: { [memberId: string]: string };
  /**
   * Per-project epic ownership: which member ids are assigned to an epic.
   * An assigned member finishes all of their assigned epics (in epic order)
   * before they're allowed to help on any epic they're not assigned to.
   * A member with no assignments anywhere behaves as a free agent (the
   * original scheduling behavior). Absent/empty = no assignments.
   */
  epicAssignments?: { [epicId: string]: ID[] };
  /**
   * Which teams participate in this project and how. Absent = every team
   * participates fully (backward compatible). When present, only the listed
   * teams participate, each with its own epic-scope / time-window constraints.
   */
  teamInclusions?: TeamInclusion[];
}

export interface AppState {
  projects: Project[];
  teams: Team[];
  /**
   * Jira trackers (see {@link Tracker}). Absent on every state saved before
   * tracking existed, and on states from clients that predate it — treat an
   * absent list as an empty one.
   */
  trackers?: Tracker[];
}

/* ------------------------------- tracking -------------------------------- */

/**
 * A link between one Jira initiative and (optionally) one Planner project, so
 * real delivery can be compared with the plan.
 *
 * A tracker holds three kinds of data with very different lifetimes:
 *  - **settings** the user chose (`initiativeUrl`, `projectId`, `taskMap`) —
 *    small, hand-edited, and the reason the tracker exists;
 *  - **`snapshot`** — derived output of the last refresh, regenerable by
 *    pressing Refresh again, and by far the largest field;
 *  - **`samples`** — the only history that is *not* regenerable: one row per
 *    refresh day, which is what makes the buffer trend visible over weeks.
 *
 * Jira credentials are deliberately absent: they live on the device (see
 * apps/web/src/lib/jiraSettings), never in AppState, so they are never synced,
 * never exported and never written to the database.
 */
export interface Tracker {
  id: ID;
  name: string;
  /** The link exactly as pasted; kept for display and "open in Jira". */
  initiativeUrl: string;
  /** Issue key parsed from the link, e.g. "ACME-12345". */
  initiativeKey: string;
  /** Site origin parsed from the link, e.g. "https://acme.atlassian.net". */
  baseUrl: string;
  /** Baseline project to compare against. Absent = nothing chosen yet (the
   *  tracker still refreshes and shows raw Jira numbers). Cleared, not
   *  orphaned, when that project is deleted. */
  projectId?: ID;
  /** Hours that make one Planner day when converting Jira seconds. Absent = 8. */
  hoursPerDay?: number;
  /**
   * Jira epic key -> Planner epic id. An explicit `null` means "extra scope,
   * deliberately not in the plan" and is excluded from earned-days totals; a
   * key absent from the map is *unmapped* and flagged in the UI as something
   * still to decide. Absent map = nothing mapped yet.
   */
  epicMap?: { [jiraEpicKey: string]: ID | null };
  /**
   * Jira child issue key -> Planner task id, matched by name, never by hand.
   * This is the primary comparison map: Jira epics often get reorganised while
   * the underlying work stays the same. `null` marks an issue that is added
   * scope (see `addedScope`), so name matching never claims it; an absent key
   * matched nothing. Absent on older trackers.
   */
  taskMap?: { [jiraIssueKey: string]: ID | null };
  /**
   * Jira child issue key -> the specialization that does it, for work that is
   * not in the plan: scope added after the plan was made. A new task gets one
   * from its tags (a Jira label or a "[QA]" tag in its summary) when they name
   * a specialization; otherwise it stays unmapped, counting for nothing, until
   * one is picked. The tracker counts added scope as extra plan work, sized by
   * Jira's estimate, on top of the baseline; the promised dates stay the
   * baseline's, so added scope uses up buffer instead of moving the deadline.
   * The same key is `null` in `taskMap`. Absent = none. See `trackerMapping`
   * in packages/jira.
   */
  addedScope?: { [jiraIssueKey: string]: string };
  /**
   * Jira epic keys whose work is not this team's — another team's epics in the
   * same initiative. Every issue under them is left out of every number, like
   * a task marked not tracked, including issues that only appear in a later
   * refresh. Task mappings under them are kept, so tracking the epic again
   * restores them. Absent = every epic is tracked.
   */
  untrackedEpics?: string[];
  /**
   * Jira epic keys of nice-to-have work: tracked on top of what the plan
   * must deliver, never as part of it. Their tasks show in the task table,
   * matched and given specializations like any other, but every reading of
   * the must-do work (status, buffer, samples) leaves them out, like an
   * untracked epic. The work-left planner can lay them out on request. An
   * epic is in at most one of this list and `untrackedEpics`. Absent = none.
   */
  niceToHaveEpics?: string[];
  /**
   * The teams whose work the reading covers, by name, as Jira's "Team" field
   * spells them ("Stars"): their Jira tasks, the plan tasks those map to, and
   * the people of the Planner teams of the same name. Lets several teams share
   * one initiative and be read apart or together. Absent or empty = every
   * team, which is how trackers always read. See `teamScope` in
   * core/src/tracking.ts.
   */
  viewTeams?: string[];
  /**
   * Jira child issue key -> the team that does it, by name, set by hand.
   * Overrides the team worked out from the issue (its Jira Team field, its
   * assignee's team, its epic's), for unassigned work or a task filed under
   * the wrong team. Absent = none set.
   */
  taskTeams?: { [jiraIssueKey: string]: string };
  /** The last refresh. Derived data — regenerable, like {@link Plan}. */
  snapshot?: JiraSnapshot;
  /** One sample per refresh day, oldest first (a same-day refresh replaces the
   *  day's entry). Capped in the reducer so a long-lived tracker stays small. */
  samples?: TrackerSample[];
  /** The sprint being laid out right now, if any. */
  sprintDraft?: SprintDraft;
  /** The dates progress is judged against. Absent = every default below. */
  deadlines?: TrackerDeadlines;
}

/**
 * How a tracker follows one Jira epic: as work the plan must deliver, not at
 * all (another team's), or as nice-to-have work on top of the plan.
 */
export type EpicTracking = "tracked" | "untracked" | "niceToHave";

/**
 * The dates a tracker judges progress against, and which work belongs to the
 * end of the project rather than to development.
 *
 * QA is the usual reason this exists. The scheduler plans QA tasks as soon as
 * a QA person is free, but QA really happens at the end, in the window between
 * the end of development and the project end date. Measured against the
 * early schedule it would read as behind all project long.
 */
export interface TrackerDeadlines {
  /**
   * Measure from this start instead of the project's own start date; the
   * project is re-planned from it. Absent = the project's start date.
   */
  startDate?: string;
  /** The end date. Absent = the baseline plan's finish with buffer. */
  endDate?: string;
  /**
   * The date development must stop so the end phase fits before `endDate`.
   * Absent = the plan's last finish (with buffer) of the specializations that
   * count as development.
   */
  devEndDate?: string;
  /**
   * Specializations whose work happens in the end phase, between `devEndDate`
   * and `endDate` — the ones *not* counted as development. Absent or empty =
   * no end phase: every specialization is development, measured against the
   * schedule, as trackers always were.
   */
  endPhase?: string[];
}

/** Everything one refresh returned. */
export interface JiraSnapshot {
  fetchedAt: string; // ISO datetime
  initiative: JiraIssue;
  epics: JiraEpic[];
  /** Custom field ids resolved on this Jira site, so a later write-back sets
   *  the same fields this snapshot read. */
  fieldIds: JiraFieldIds;
}

/** Ids of the non-standard fields this integration needs. */
export interface JiraFieldIds {
  startDate?: string; // commonly customfield_10015
  sprint?: string; // commonly customfield_10020
  storyPoints?: string; // instance-specific
  team?: string; // Atlassian "Team", commonly customfield_10001
}

/** Jira's three status buckets. Only `done` counts as finished. */
export type JiraStatusCategory = "new" | "indeterminate" | "done";

/** One Jira issue, flattened to the fields tracking actually uses. */
export interface JiraIssue {
  key: string;
  summary: string;
  issueType: string; // "Epic", "Story", "Task", "Bug", "Initiative", …
  status: string; // display name, e.g. "In Progress"
  statusCategory: JiraStatusCategory;
  assignee?: { accountId: string; displayName: string };
  parentKey?: string;
  originalEstimateSec?: number;
  remainingEstimateSec?: number;
  timeSpentSec?: number;
  startDate?: string; // ISO date
  dueDate?: string; // ISO date
  resolutionDate?: string; // ISO datetime
  sprint?: string; // name of the issue's active/last sprint
  /**
   * Jira labels, as typed ("backend", "QA"). Only read when building a plan
   * from Jira, where a label naming a specialization says who does the work.
   * Absent in snapshots saved before labels were fetched.
   */
  labels?: string[];
  /**
   * The Jira "Team" the issue belongs to, by name ("Stars"). Says whose work
   * it is when several teams share an initiative. Absent when unset, and in
   * snapshots saved before the field was fetched.
   */
  team?: string;
  updated: string; // ISO datetime
}

/** An epic plus its children and the totals computed from them. */
export interface JiraEpic extends JiraIssue {
  children: JiraIssue[];
  /**
   * Sums over `children`, never read from Jira's own aggregate fields (those
   * include the epic's own estimate and would double-count). A child in the
   * `done` category contributes 0 remaining whatever its field says.
   */
  totals: JiraEpicTotals;
}

export interface JiraEpicTotals {
  originalSec: number;
  spentSec: number;
  remainingSec: number;
  /** Children in the `done` status category. */
  done: number;
  /** Children in total. */
  all: number;
}

/**
 * One "how were we doing on day X" reading, written on every refresh.
 *
 * Samples are what a snapshot cannot give you: pressing Refresh again shows
 * today, but only the sample history shows whether the buffer is being eaten
 * faster this week than last.
 */
export interface TrackerSample {
  date: string; // ISO date of the refresh
  /** Plan days the unbuffered plan expected to be finished by `date`. */
  plannedDays: number;
  /** Plan days Jira says are actually finished. */
  earnedDays: number;
  /** Working days ahead (positive) or behind (negative). */
  varianceDays: number;
  /** Schedule buffer consumed, clamped to [0, bufferDays]. */
  bufferUsedDays: number;
  /** Schedule buffer available in total, for reading the ratio later. */
  bufferDays: number;
  jiraSpentDays: number;
  jiraRemainingDays: number;
}

/** A sprint being laid out against today's reality, not the plan's dates. */
export interface SprintDraft {
  start: string; // ISO date
  end: string; // ISO date, inclusive
  items: SprintDraftItem[];
}

export interface SprintDraftItem {
  /** The Jira issue this row plans. Identity of the row. */
  issueKey: string;
  /** Team member or project helper. Absent = not assigned yet. */
  memberId?: ID;
  estimateDays: number;
  /** User-set start; the due date is computed from it, never stored. */
  start: string; // ISO date
  /** Set once these dates were successfully written to Jira. */
  applied?: { at: string; startDate: string; dueDate: string };
}
