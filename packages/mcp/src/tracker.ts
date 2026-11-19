/**
 * Read tools for Jira trackers: the reading, the history, and what changed.
 *
 * Everything comes from the tracker as it is stored - its last snapshot, its
 * samples, its maps. Nothing here talks to Jira (no tool refreshes a tracker:
 * that needs the Jira credentials, which never leave the window's own
 * storage), so a reading is as fresh as the last Refresh, and every result
 * says when that was.
 *
 * The postmortem tool returns facts and links, not conclusions: what was added
 * to the plan, what Jira has that matches nothing, what the plan has that
 * Jira never got, and how estimates moved. The client writes the summary.
 */
import {
  epicTracking,
  jiraTaskTeams,
  jiraTasks,
  trackerStatus,
  trackerTeams,
  type AppState,
  type ID,
  type JiraIssue,
  type JiraSnapshot,
  type Project,
  type Tracker,
} from "@planner/core";
import { estimateUpdates, secondsToDays, trackerMapping } from "@planner/jira";
import type { ToolContext } from "./context";
import { findTracker } from "./resolve";

const DEFAULT_HOURS_PER_DAY = 8;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function issueLink(baseUrl: string, key: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/browse/${encodeURIComponent(key)}`;
}

function projectOf(state: AppState, tracker: Tracker): Project | undefined {
  return tracker.projectId
    ? state.projects.find((p) => p.id === tracker.projectId)
    : undefined;
}

function ageDays(fetchedAt: string | undefined, now: string): number | null {
  if (!fetchedAt) return null;
  const then = Date.parse(fetchedAt);
  const current = Date.parse(now);
  if (!Number.isFinite(then) || !Number.isFinite(current)) return null;
  return Math.floor((current - then) / 86_400_000);
}

export type IssueClass =
  "matched" | "added_scope" | "unmapped" | "untracked" | "nice_to_have";

interface Mapping {
  taskMap: NonNullable<Tracker["taskMap"]>;
  addedScope: NonNullable<Tracker["addedScope"]>;
}

/**
 * The mapping the tracker page shows: the stored one, completed by name
 * matching and tags exactly as a refresh would (see `trackerMapping`).
 */
function effectiveMapping(
  ctx: ToolContext,
  tracker: Tracker,
  project: Project | undefined,
): Mapping {
  if (tracker.snapshot && project) {
    return trackerMapping({
      project,
      teams: ctx.state.teams,
      snapshot: tracker.snapshot,
      tracker,
      tagAliases: ctx.tagAliases,
    });
  }
  return {
    taskMap: tracker.taskMap ?? {},
    addedScope: tracker.addedScope ?? {},
  };
}

interface ClassifiedIssue {
  issue: JiraIssue;
  epic: { key: string; summary: string };
  kind: IssueClass;
  planTaskId?: ID;
  specialization?: string;
}

function classifyIssues(
  tracker: Tracker,
  snapshot: JiraSnapshot,
  mapping: Mapping,
): ClassifiedIssue[] {
  const epicOf = new Map<string, { key: string; summary: string }>();
  for (const epic of snapshot.epics ?? []) {
    for (const child of epic.children ?? []) {
      if (!epicOf.has(child.key)) {
        epicOf.set(child.key, { key: epic.key, summary: epic.summary });
      }
    }
  }
  return jiraTasks(snapshot).map((issue) => {
    const epic = epicOf.get(issue.key) ?? { key: "", summary: "" };
    const tracking = epicTracking(tracker, epic.key);
    if (tracking === "untracked") return { issue, epic, kind: "untracked" };
    const target = mapping.taskMap[issue.key];
    const base: Omit<ClassifiedIssue, "kind"> = { issue, epic };
    if (typeof target === "string") base.planTaskId = target;
    else if (mapping.addedScope[issue.key]) {
      base.specialization = mapping.addedScope[issue.key];
    }
    if (tracking === "niceToHave") return { ...base, kind: "nice_to_have" };
    if (base.planTaskId) return { ...base, kind: "matched" };
    if (base.specialization) return { ...base, kind: "added_scope" };
    return { ...base, kind: "unmapped" };
  });
}

function issueRow(
  c: ClassifiedIssue,
  tracker: Tracker,
  project: Project | undefined,
  teamOf: Map<string, { team: string }>,
) {
  const hours = tracker.hoursPerDay ?? DEFAULT_HOURS_PER_DAY;
  const days = (sec: number | undefined) =>
    sec === undefined ? null : round2(secondsToDays(sec, hours));
  const { issue } = c;
  let planTask:
    | { id: ID; name: string; epicName: string; estimateDays: number }
    | undefined;
  if (c.planTaskId && project) {
    for (const epic of project.epics) {
      const t = epic.tasks.find((x) => x.id === c.planTaskId);
      if (t) {
        planTask = {
          id: t.id,
          name: t.name,
          epicName: epic.name,
          estimateDays: t.estimateDays,
        };
        break;
      }
    }
  }
  return {
    key: issue.key,
    link: issueLink(tracker.baseUrl, issue.key),
    summary: issue.summary,
    issueType: issue.issueType,
    status: issue.status,
    statusCategory: issue.statusCategory,
    classification: c.kind,
    epic: c.epic.key
      ? {
          key: c.epic.key,
          summary: c.epic.summary,
          link: issueLink(tracker.baseUrl, c.epic.key),
        }
      : null,
    ...(planTask ? { planTask } : {}),
    ...(c.specialization ? { specialization: c.specialization } : {}),
    team: teamOf.get(issue.key)?.team ?? issue.team ?? null,
    assignee: issue.assignee?.displayName ?? null,
    ...(issue.labels?.length ? { labels: issue.labels } : {}),
    originalEstimateDays: days(issue.originalEstimateSec),
    spentDays: days(issue.timeSpentSec),
    remainingDays:
      issue.statusCategory === "done" ? 0 : days(issue.remainingEstimateSec),
    ...(issue.startDate ? { startDate: issue.startDate } : {}),
    ...(issue.dueDate ? { dueDate: issue.dueDate } : {}),
    ...(issue.resolutionDate ? { resolvedAt: issue.resolutionDate } : {}),
    ...(issue.sprint ? { sprint: issue.sprint } : {}),
    updatedAt: issue.updated,
  };
}

type IssueRow = ReturnType<typeof issueRow>;

/** Every Jira task of a tracker, classified and linked. */
function trackerIssues(ctx: ToolContext, tracker: Tracker): IssueRow[] {
  const snapshot = tracker.snapshot;
  if (!snapshot) return [];
  const project = projectOf(ctx.state, tracker);
  const mapping = effectiveMapping(ctx, tracker, project);
  const teamOf = project
    ? jiraTaskTeams(snapshot, project, ctx.state.teams, tracker.taskTeams)
    : new Map<string, { team: string }>();
  return classifyIssues(tracker, snapshot, mapping).map((c) =>
    issueRow(c, tracker, project, teamOf),
  );
}

function statusOf(ctx: ToolContext, tracker: Tracker) {
  return trackerStatus(
    tracker,
    projectOf(ctx.state, tracker),
    ctx.state.teams,
    ctx.today,
  );
}

function countBy(rows: IssueRow[]): Record<IssueClass, number> {
  const out: Record<IssueClass, number> = {
    matched: 0,
    added_scope: 0,
    unmapped: 0,
    untracked: 0,
    nice_to_have: 0,
  };
  for (const r of rows) out[r.classification]++;
  return out;
}

export function listTrackers(ctx: ToolContext) {
  return {
    today: ctx.today,
    trackers: (ctx.state.trackers ?? []).map((t) => {
      const project = projectOf(ctx.state, t);
      const status = statusOf(ctx, t);
      return {
        id: t.id,
        name: t.name,
        initiativeKey: t.initiativeKey,
        initiativeLink: issueLink(t.baseUrl, t.initiativeKey),
        project: project ? { id: project.id, name: project.name } : null,
        lastRefresh: t.snapshot?.fetchedAt ?? null,
        snapshotAgeDays: ageDays(t.snapshot?.fetchedAt, ctx.now),
        samples: t.samples?.length ?? 0,
        status: status.kind,
        ...(status.reason ? { reason: status.reason } : {}),
        varianceDays: status.varianceDays,
        bufferDays: status.bufferDays,
        bufferUsedDays: status.bufferUsedDays,
        projectedFinish: status.projectedFinish,
        promisedFinish: status.bufferedEnd,
      };
    }),
  };
}

export function getTracker(
  ctx: ToolContext,
  args: { tracker: string; include_samples?: boolean },
) {
  const tracker = findTracker(ctx.state, args.tracker);
  const project = projectOf(ctx.state, tracker);
  const snapshot = tracker.snapshot;
  const hours = tracker.hoursPerDay ?? DEFAULT_HOURS_PER_DAY;
  const rows = trackerIssues(ctx, tracker);
  const planEpicName = new Map(
    (project?.epics ?? []).map((e) => [e.id, e.name]),
  );
  return {
    id: tracker.id,
    name: tracker.name,
    initiative: {
      key: tracker.initiativeKey,
      link: issueLink(tracker.baseUrl, tracker.initiativeKey),
      ...(snapshot
        ? {
            summary: snapshot.initiative.summary,
            status: snapshot.initiative.status,
          }
        : {}),
    },
    project: project ? { id: project.id, name: project.name } : null,
    hoursPerDay: hours,
    deadlines: tracker.deadlines ?? null,
    viewTeams: tracker.viewTeams ?? [],
    teams: project ? trackerTeams(tracker, project, ctx.state.teams) : [],
    lastRefresh: snapshot?.fetchedAt ?? null,
    snapshotAgeDays: ageDays(snapshot?.fetchedAt, ctx.now),
    status: statusOf(ctx, tracker),
    issueCounts: countBy(rows),
    epics: (snapshot?.epics ?? []).map((e) => {
      const mapped = tracker.epicMap?.[e.key];
      return {
        key: e.key,
        link: issueLink(tracker.baseUrl, e.key),
        summary: e.summary,
        status: e.status,
        statusCategory: e.statusCategory,
        tracking: epicTracking(tracker, e.key),
        planEpic:
          mapped === undefined
            ? "unmapped"
            : mapped === null
              ? "not in plan"
              : { id: mapped, name: planEpicName.get(mapped) ?? "(missing)" },
        tasks: e.totals.all,
        done: e.totals.done,
        originalDays: round2(secondsToDays(e.totals.originalSec, hours)),
        spentDays: round2(secondsToDays(e.totals.spentSec, hours)),
        remainingDays: round2(secondsToDays(e.totals.remainingSec, hours)),
      };
    }),
    ...((args.include_samples ?? true)
      ? { samples: tracker.samples ?? [] }
      : {}),
  };
}

export function getTrackerIssues(
  ctx: ToolContext,
  args: { tracker: string; classification?: IssueClass | "all" },
) {
  const tracker = findTracker(ctx.state, args.tracker);
  const rows = trackerIssues(ctx, tracker);
  const filter = args.classification ?? "all";
  return {
    tracker: { id: tracker.id, name: tracker.name },
    lastRefresh: tracker.snapshot?.fetchedAt ?? null,
    counts: countBy(rows),
    issues:
      filter === "all" ? rows : rows.filter((r) => r.classification === filter),
  };
}

/**
 * The facts a postmortem needs: how the work in Jira compares with the plan
 * it was measured against, and how the buffer was spent over time.
 */
export function getTrackerScopeChanges(
  ctx: ToolContext,
  args: { tracker: string },
) {
  const tracker = findTracker(ctx.state, args.tracker);
  const project = projectOf(ctx.state, tracker);
  const snapshot = tracker.snapshot;
  const rows = trackerIssues(ctx, tracker);
  const counts = countBy(rows);
  const hours = tracker.hoursPerDay ?? DEFAULT_HOURS_PER_DAY;

  const added = rows.filter((r) => r.classification === "added_scope");
  const bySpec = new Map<
    string,
    { specialization: string; issues: number; days: number }
  >();
  for (const r of added) {
    const spec = r.specialization ?? "";
    const e = bySpec.get(spec) ?? { specialization: spec, issues: 0, days: 0 };
    e.issues++;
    e.days = round2(e.days + (r.originalEstimateDays ?? 0));
    bySpec.set(spec, e);
  }

  // Plan tasks no tracked Jira task claims: planned, never ticketed (or
  // ticketed under a name that matches nothing).
  const claimed = new Set(
    rows
      .filter((r) => r.classification === "matched" && r.planTask)
      .map((r) => r.planTask!.id),
  );
  const planTasks = (project?.epics ?? []).flatMap((e) =>
    e.tasks
      .filter((t) => !t.excluded)
      .map((t) => ({ epicName: e.name, task: t })),
  );
  const planTasksWithoutJira = planTasks
    .filter(({ task }) => !claimed.has(task.id))
    .map(({ epicName, task }) => ({
      taskId: task.id,
      name: task.name,
      epicName,
      specialization: task.specialization,
      estimateDays: task.estimateDays,
    }));

  const mapping = effectiveMapping(ctx, tracker, project);
  const estimateChanges =
    snapshot && project
      ? estimateUpdates(project, snapshot, mapping.taskMap, hours).map((u) => ({
          taskId: u.taskId,
          taskName: u.taskName,
          epicName: u.epicName,
          planDays: u.currentDays,
          jiraDays: u.jiraDays,
          deltaDays: round2(u.jiraDays - u.currentDays),
          skippedInPlan: u.currentExcluded,
          issues: u.issueKeys.map((key) => ({
            key,
            link: issueLink(tracker.baseUrl, key),
          })),
        }))
      : [];

  const epicRef = (key: string) => {
    const e = snapshot?.epics.find((x) => x.key === key);
    return {
      key,
      link: issueLink(tracker.baseUrl, key),
      summary: e?.summary ?? null,
    };
  };
  const samples = tracker.samples ?? [];

  return {
    tracker: {
      id: tracker.id,
      name: tracker.name,
      initiativeKey: tracker.initiativeKey,
      initiativeLink: issueLink(tracker.baseUrl, tracker.initiativeKey),
    },
    project: project ? { id: project.id, name: project.name } : null,
    lastRefresh: snapshot?.fetchedAt ?? null,
    note: "Jira snapshots carry no creation dates. 'Added scope' is Jira work that matches no task in the baseline plan, sized by its Jira estimate; 'unmapped' is such work whose specialization nobody picked, so it counts for nothing yet. Numbers are as of the last refresh.",
    counts: {
      planTasks: planTasks.length,
      planTasksMatched: claimed.size,
      planTasksWithoutJira: planTasksWithoutJira.length,
      jiraTasks: rows.length,
      ...counts,
    },
    addedScope: {
      totalDays: round2(
        added.reduce((s, r) => s + (r.originalEstimateDays ?? 0), 0),
      ),
      bySpecialization: [...bySpec.values()].sort((a, b) => b.days - a.days),
      issues: added,
    },
    unmapped: rows.filter((r) => r.classification === "unmapped"),
    planTasksWithoutJira,
    estimateChanges,
    epicsNotInPlan: Object.entries(tracker.epicMap ?? {})
      .filter(([, v]) => v === null)
      .map(([key]) => epicRef(key)),
    untrackedEpics: (tracker.untrackedEpics ?? []).map(epicRef),
    niceToHaveEpics: (tracker.niceToHaveEpics ?? []).map(epicRef),
    buffer: {
      samples: samples.length,
      first: samples[0] ?? null,
      last: samples[samples.length - 1] ?? null,
    },
    status: statusOf(ctx, tracker),
  };
}
