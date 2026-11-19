import { useEffect, useMemo, useState } from "react";
import {
  earnedTaskDays,
  teamKey,
  trackedMapping,
  type EpicTracking,
  withAddedScope,
  type JiraIssue,
  type JiraSnapshot,
  type Project,
  type TaskTeamSource,
  type Tracker,
  type TrackerTeam,
} from "@planner/core";
import { estimateOf } from "@planner/jira";
import { Button } from "../ui/Button";
import { days } from "./StatusPanel";

type SortKey = "order" | "unmatched" | "shortfall";

/** The specialization filter's value for new tasks with none picked yet. */
const NO_SPECIALIZATION = "__unmapped__";

interface TasksTableProps {
  snapshot: JiraSnapshot;
  baseUrl: string;
  project: Project;
  /** Jira task -> the plan task it matched by name (see `trackerMapping`). */
  taskMap: Tracker["taskMap"];
  /** Converts Jira's time estimates to days for the no-estimate hint. */
  hoursPerDay?: number;
  /** Opens the estimate review, offered on a task Jira has an estimate for. */
  onReviewEstimates?: () => void;
  /** New Jira tasks counted as added scope, with the specialization doing
   *  each: read from their tags, or picked here. */
  addedScope?: Tracker["addedScope"];
  /** Specializations to pick from for a new task. */
  specializations?: readonly string[];
  /** Set the specialization doing a new task, which makes it added scope. */
  onSetAddedScope?: (jiraIssueKey: string, specialization: string) => void;
  /** Jira epics left out as another team's work. */
  untrackedEpics?: Tracker["untrackedEpics"];
  /** Jira epics followed as nice-to-have work, on top of the plan. */
  niceToHaveEpics?: Tracker["niceToHaveEpics"];
  /** Track a whole Jira epic, leave it out as another team's, or follow it
   *  as nice to have. */
  onSetEpicTracking?: (jiraEpicKey: string, tracking: EpicTracking) => void;
  /**
   * The tracker's teams, when there is more than one: each Jira task then
   * shows the team it belongs to, from Jira or set by hand.
   */
  teams?: TrackerTeam[];
  /** Each Jira task's team, as core works it out (`jiraTaskTeams`). */
  taskTeams?: Map<string, { team: string; source: TaskTeamSource }>;
  /** Set a Jira task's team by hand, or go back to Jira's (null). */
  onSetTaskTeam?: (jiraIssueKey: string, team: string | null) => void;
  /**
   * The teams the tracker's reading is limited to (`selectedTeams`), or
   * null/absent for every team. Other teams' tasks are hidden, and so is an
   * epic left with none. A task with no team stays, so it can be given one.
   */
  shownTeams?: string[] | null;
}

/**
 * A Jira task is a plan task (matched by name), added scope (new work with a
 * specialization), or undecided: new work whose tags name no specialization.
 */
type MappingState = "mapped" | "added" | "undecided";

function mappingState(
  taskMap: Tracker["taskMap"],
  addedScope: Tracker["addedScope"],
  key: string,
): MappingState {
  if ((addedScope ?? {})[key]) return "added";
  return typeof (taskMap ?? {})[key] === "string" ? "mapped" : "undecided";
}

/** Id of an epic's tracking control, so focus can follow it when it moves. */
function epicTrackingId(epicKey: string): string {
  return `epic-tracking-${epicKey}`;
}

interface JiraTaskGroup {
  epicKey: string;
  epicSummary: string;
  /** The Jira epic's own status, shown on its row once it is done. */
  epicStatus: string;
  epicDone: boolean;
  issues: JiraIssue[];
}

/** To do first, then in progress, done last. */
const STATUS_RANK: Record<JiraIssue["statusCategory"], number> = {
  new: 0,
  indeterminate: 1,
  done: 2,
};

/**
 * Statuses that close work without doing it. Jira files them in the Done
 * category next to real completion, so they sort after the rest of it.
 */
const ABANDONED_STATUS =
  /cancel|won'?t|reject|obsolete|duplicate|abandon|declin|invalid/i;

/**
 * Orders a Jira status category by status name, so "Done" and "Cancelled"
 * each read as one block: abandoned-looking statuses last, the rest A to Z.
 */
function compareStatus(a: JiraIssue, b: JiraIssue): number {
  const abandoned = (issue: JiraIssue) =>
    Number(ABANDONED_STATUS.test(issue.status ?? ""));
  return (
    abandoned(a) - abandoned(b) ||
    (a.status ?? "").localeCompare(b.status ?? "", undefined, {
      sensitivity: "base",
    })
  );
}

/** Jira child tasks grouped under their Jira epic, both in Jira order. */
function taskGroups(snapshot: JiraSnapshot): JiraTaskGroup[] {
  const out: JiraTaskGroup[] = [];
  const seen = new Set<string>();
  for (const epic of snapshot.epics ?? []) {
    const issues: JiraIssue[] = [];
    for (const issue of epic.children ?? []) {
      if (!issue.key || seen.has(issue.key)) continue;
      seen.add(issue.key);
      issues.push(issue);
    }
    if (issues.length > 0) {
      out.push({
        epicKey: epic.key,
        epicSummary: epic.summary,
        epicStatus: epic.status,
        epicDone: epic.statusCategory === "done",
        issues,
      });
    }
  }
  return out;
}

export function TasksTable({
  snapshot,
  baseUrl,
  project,
  taskMap,
  hoursPerDay,
  onReviewEstimates,
  addedScope,
  specializations = [],
  onSetAddedScope,
  untrackedEpics,
  niceToHaveEpics,
  onSetEpicTracking,
  teams,
  taskTeams,
  onSetTaskTeam,
  shownTeams,
}: TasksTableProps) {
  const showTeams = (teams?.length ?? 0) > 1;
  const [sort, setSort] = useState<SortKey>("unmatched");
  // Local UI state, like the sort: "" shows every specialization.
  const [specFilter, setSpecFilter] = useState("");
  // Local UI state too: hides Jira tasks in the Done category, and any epic
  // left with none, so the table reads as the work still open.
  const [hideDone, setHideDone] = useState(false);
  // Local UI state, not persisted: which Jira epics show their tasks. Epics
  // start collapsed so a large initiative opens as a compact list, and an
  // epic that appears after a refresh is not in the set, so it starts
  // collapsed too.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const untracked = useMemo(
    () => new Set(untrackedEpics ?? []),
    [untrackedEpics],
  );
  const niceToHave = useMemo(
    () => new Set(niceToHaveEpics ?? []),
    [niceToHaveEpics],
  );
  // Measured exactly as the tracker measures it: another team's epics count
  // for nothing, and added scope becomes plan tasks of its own, sized by Jira,
  // so its rows show planned and earned days.
  const measured = useMemo(() => {
    const tracked = trackedMapping({
      snapshot,
      taskMap,
      addedScope,
      untrackedEpics,
    });
    return withAddedScope(
      project,
      snapshot,
      tracked.taskMap,
      tracked.addedScope,
      hoursPerDay,
    );
  }, [project, snapshot, taskMap, addedScope, untrackedEpics, hoursPerDay]);
  const earned = useMemo(
    () => earnedTaskDays(measured.project, snapshot, measured.taskMap),
    [measured, snapshot],
  );
  const stateOf = (key: string) => mappingState(taskMap, addedScope, key);

  // The plan task each matched Jira task counts as, by id, for its row.
  const planTaskNames = useMemo(() => {
    const out = new Map<string, { name: string; epic: string }>();
    for (const epic of project.epics) {
      for (const task of epic.tasks) {
        out.set(task.id, {
          name: task.excluded ? `${task.name} (skipped)` : task.name,
          epic: epic.name,
        });
      }
    }
    return out;
  }, [project.epics]);

  // Mapped onto a plan task that counts for nothing: no estimate, or skipped.
  // Only the plan's estimate is measured, so these are worth fixing first.
  // Added scope counts too: it is sized by Jira, so one with no Jira estimate
  // is a skipped 0-day task like any other. A task already done is past
  // fixing, so it is shown greyed out and never flagged or counted — see
  // `needsEstimate`.
  const noEstimate = useMemo(() => {
    const unestimated = new Set<string>();
    for (const epic of measured.project.epics) {
      for (const task of epic.tasks) {
        if (task.excluded || !(Number(task.estimateDays) > 0)) {
          unestimated.add(task.id);
        }
      }
    }
    return (key: string) => {
      const target = (measured.taskMap ?? {})[key];
      return typeof target === "string" && unestimated.has(target);
    };
  }, [measured]);
  const needsEstimate = (issue: JiraIssue) =>
    issue.statusCategory !== "done" && noEstimate(issue.key);

  // A Jira task's specialization is its plan task's — added scope included,
  // since it stands in as a plan task of its own. Mapped to nothing: none.
  const specOf = useMemo(() => {
    const byTask = new Map<string, string>();
    for (const epic of measured.project.epics) {
      for (const task of epic.tasks) byTask.set(task.id, task.specialization);
    }
    return (key: string): string | null => {
      const id = (measured.taskMap ?? {})[key];
      return (typeof id === "string" && byTask.get(id)) || null;
    };
  }, [measured]);
  const specOptions = useMemo(() => {
    const found = new Set<string>();
    let unmapped = false;
    for (const group of taskGroups(snapshot)) {
      for (const issue of group.issues) {
        const spec = specOf(issue.key);
        if (spec) found.add(spec);
        else unmapped = true;
      }
    }
    return {
      specs: [...found].sort((a, b) => a.localeCompare(b)),
      unmapped,
    };
  }, [snapshot, specOf]);
  // A filter on a specialization that has since gone shows everything.
  const activeSpec =
    specFilter === NO_SPECIALIZATION
      ? specOptions.unmapped
        ? specFilter
        : ""
      : specOptions.specs.includes(specFilter)
        ? specFilter
        : "";

  // The team(s) each epic's tasks belong to, most tasks first. An epic is
  // usually one team's; a mixed one names every team in it.
  const epicTeams = useMemo(() => {
    const out = new Map<string, string[]>();
    for (const group of taskGroups(snapshot)) {
      const counts = new Map<string, { name: string; n: number }>();
      for (const issue of group.issues) {
        const owner = taskTeams?.get(issue.key);
        if (!owner) continue;
        const key = teamKey(owner.team);
        const entry = counts.get(key) ?? { name: owner.team, n: 0 };
        entry.n++;
        counts.set(key, entry);
      }
      out.set(
        group.epicKey,
        [...counts.values()].sort((a, b) => b.n - a.n).map((e) => e.name),
      );
    }
    return out;
  }, [snapshot, taskTeams]);

  const groups = useMemo(() => {
    const shortfall = (issue: JiraIssue) => {
      const row = earned.perJiraTask.get(issue.key);
      return (row?.plannedDays ?? 0) - (row?.earned ?? 0);
    };
    let list = taskGroups(snapshot);
    // Each filter keeps the tasks it wants and drops an epic left with none.
    // An epic set to not be tracked is never filtered: it stays in view, with
    // all its tasks, so it can always be tracked again.
    const narrow = (keep: (issue: JiraIssue) => boolean) => {
      list = list
        .map((group) =>
          untracked.has(group.epicKey)
            ? group
            : { ...group, issues: group.issues.filter(keep) },
        )
        .filter((group) => group.issues.length > 0);
    };
    if (shownTeams && shownTeams.length > 0) {
      const wanted = new Set(shownTeams.map(teamKey));
      narrow((issue) => {
        const owner = taskTeams?.get(issue.key);
        return !owner || wanted.has(teamKey(owner.team));
      });
    }
    if (hideDone) narrow((issue) => issue.statusCategory !== "done");
    if (activeSpec) {
      const wanted = activeSpec === NO_SPECIALIZATION ? null : activeSpec;
      narrow((issue) => specOf(issue.key) === wanted);
    }
    for (const group of list) {
      if (sort === "unmatched") {
        // Unmapped first, then mapped with no estimate: both need fixing.
        const rank = (issue: JiraIssue) =>
          stateOf(issue.key) === "undecided" ? 0 : needsEstimate(issue) ? 1 : 2;
        group.issues.sort((a, b) => rank(a) - rank(b));
      } else if (sort === "shortfall") {
        group.issues.sort((a, b) => shortfall(b) - shortfall(a));
      }
      // Whatever the sort, work still to do comes first and done work last,
      // grouped by status within each category (Done before Cancelled). The
      // sort is stable, so the order above holds within each status.
      group.issues.sort(
        (a, b) =>
          (STATUS_RANK[a.statusCategory] ?? 0) -
            (STATUS_RANK[b.statusCategory] ?? 0) || compareStatus(a, b),
      );
    }
    // Epics keep Jira order while mapping, so an epic never jumps away from
    // under the picker you just changed. Shortfall is a reading, not an
    // editing, order, so there the epics are ranked too.
    if (sort === "shortfall") {
      const total = (group: JiraTaskGroup) =>
        group.issues.reduce((sum, issue) => sum + shortfall(issue), 0);
      list.sort((a, b) => total(b) - total(a));
    }
    // In every sort but Jira's own order, the must-do work reads as one
    // block: nice-to-have epics after it, another team's last. The sort is
    // stable: order within each is kept.
    if (sort !== "order") {
      const rank = (key: string) =>
        untracked.has(key) ? 2 : niceToHave.has(key) ? 1 : 0;
      list.sort((a, b) => rank(a.epicKey) - rank(b.epicKey));
    }
    return list;
    // stateOf only reads taskMap and addedScope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    earned,
    snapshot,
    sort,
    taskMap,
    addedScope,
    noEstimate,
    untracked,
    niceToHave,
    activeSpec,
    specOf,
    shownTeams,
    taskTeams,
    hideDone,
  ]);

  // Tracking or untracking an epic can move it to the other end of the list,
  // and the move must not drop keyboard focus: put it back on the same control.
  const [refocus, setRefocus] = useState<string | null>(null);
  useEffect(() => {
    if (!refocus) return;
    document.getElementById(epicTrackingId(refocus))?.focus();
    setRefocus(null);
  }, [refocus, groups]);

  const epicKeys = groups.map((group) => group.epicKey);
  const allExpanded =
    epicKeys.length > 0 && epicKeys.every((key) => expanded.has(key));

  const toggleEpic = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const toggleAll = () =>
    setExpanded(allExpanded ? new Set() : new Set(epicKeys));

  const mappedTaskIds = new Set(
    Object.values(measured.taskMap ?? {}).filter(
      (value): value is string => typeof value === "string",
    ),
  );
  const planOnly = project.epics.flatMap((epic) =>
    epic.tasks
      .filter((task) => !task.excluded && !mappedTaskIds.has(task.id))
      .map((task) => `${epic.name} / ${task.name}`),
  );

  return (
    <section className="tasks-section" aria-label="Task comparison">
      <div className="epics-head">
        <div>
          <h2 className="section-title">Task comparison</h2>
          <p className="muted">
            Jira tasks are matched to planned tasks by name. A Jira task with no
            match is added scope: work taken on after planning, sized by
            Jira&apos;s estimate, that uses up buffer. Its specialization comes
            from a Jira label or a [tag] in its summary; where neither names
            one, the task stays unmapped until you pick it. Only Jira tasks in
            the Done category count as earned. A nice-to-have epic is followed
            here but left out of the status above.
          </p>
        </div>
        <div className="tasks-head-controls">
          {groups.length > 0 && (
            <Button small onClick={toggleAll}>
              {allExpanded ? "Collapse all" : "Expand all"}
            </Button>
          )}
          {specOptions.specs.length + (specOptions.unmapped ? 1 : 0) > 1 && (
            <label className="epics-sort">
              <span>Specialization</span>
              <select
                value={activeSpec}
                onChange={(event) => setSpecFilter(event.target.value)}
              >
                <option value="">All</option>
                {specOptions.specs.map((spec) => (
                  <option key={spec} value={spec}>
                    {spec}
                  </option>
                ))}
                {specOptions.unmapped && (
                  <option value={NO_SPECIALIZATION}>Unmapped</option>
                )}
              </select>
            </label>
          )}
          <label className="epics-sort">
            <input
              type="checkbox"
              checked={hideDone}
              onChange={(event) => setHideDone(event.target.checked)}
            />
            <span>Hide done tasks</span>
          </label>
          <label className="epics-sort">
            <span>Sort</span>
            <select
              value={sort}
              onChange={(event) => setSort(event.target.value as SortKey)}
            >
              <option value="unmatched">Unmapped first</option>
              <option value="order">Jira order</option>
              <option value="shortfall">Biggest shortfall</option>
            </select>
          </label>
        </div>
      </div>

      <div className="table-scroll">
        <table className="epics-table tasks-table">
          <thead>
            <tr>
              <th scope="col">Key</th>
              <th scope="col">Jira task</th>
              <th scope="col">Status</th>
              {showTeams && <th scope="col">Team</th>}
              <th scope="col">Plan task</th>
              <th scope="col">Planned</th>
              <th scope="col">Earned</th>
              <th scope="col">Done</th>
            </tr>
          </thead>
          {groups.map((group) => {
            const open = expanded.has(group.epicKey);
            const off = untracked.has(group.epicKey);
            const nice = !off && niceToHave.has(group.epicKey);
            let undecided = 0;
            let added = 0;
            let unestimated = 0;
            let done = 0;
            let planned = 0;
            let earnedDays = 0;
            for (const issue of group.issues) {
              const rowState = stateOf(issue.key);
              if (rowState === "undecided") undecided += 1;
              if (rowState === "added") added += 1;
              if (needsEstimate(issue)) unestimated += 1;
              if (issue.statusCategory === "done") done += 1;
              const progress = earned.perJiraTask.get(issue.key);
              planned += progress?.plannedDays ?? 0;
              earnedDays += progress?.earned ?? 0;
            }
            const count = group.issues.length;
            return (
              <tbody
                key={group.epicKey}
                className={
                  "task-group" +
                  (off ? " untracked" : nice ? " nice-to-have" : "")
                }
              >
                <tr className="task-group-row">
                  <th scope="rowgroup" colSpan={showTeams ? 5 : 4}>
                    <div className="task-group-head">
                      <button
                        type="button"
                        className="task-group-toggle"
                        aria-expanded={open}
                        onClick={() => toggleEpic(group.epicKey)}
                      >
                        <span aria-hidden="true" className="chevron">
                          {open ? "▾" : "▸"}
                        </span>
                        {group.epicSummary}
                      </button>
                      <a
                        className="task-group-key"
                        href={`${baseUrl}/browse/${group.epicKey}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {group.epicKey}
                      </a>
                      {showTeams &&
                        (epicTeams.get(group.epicKey) ?? []).length > 0 && (
                          <span
                            className="epic-team"
                            title="The team its Jira tasks belong to"
                          >
                            {epicTeams.get(group.epicKey)!.join(" · ")}
                          </span>
                        )}
                      <span className="muted">
                        {count} task{count === 1 ? "" : "s"}
                      </span>
                      {group.epicDone && (
                        <span className="jira-status done">
                          {group.epicStatus || "Done"}
                        </span>
                      )}
                      {off ? (
                        <span className="untracked-label">
                          Not tracked (another team)
                        </span>
                      ) : (
                        <>
                          {nice && (
                            <span className="nice-to-have-label">
                              Nice to have
                            </span>
                          )}
                          {undecided > 0 && (
                            <span className="unmapped-count">
                              {undecided} unmapped
                            </span>
                          )}
                          {added > 0 && (
                            <span className="added-scope-count">
                              {added} added scope
                            </span>
                          )}
                          {unestimated > 0 && (
                            <span className="no-estimate-count">
                              {unestimated} without estimate
                            </span>
                          )}
                        </>
                      )}
                      {onSetEpicTracking && (
                        <select
                          id={epicTrackingId(group.epicKey)}
                          className="epic-tracking"
                          aria-label={`Tracking for epic ${group.epicKey} ${group.epicSummary}`}
                          value={
                            off ? "untracked" : nice ? "niceToHave" : "tracked"
                          }
                          onChange={(e) => {
                            onSetEpicTracking(
                              group.epicKey,
                              e.target.value as EpicTracking,
                            );
                            setRefocus(group.epicKey);
                          }}
                        >
                          <option value="tracked">Track it</option>
                          <option value="niceToHave">Nice to have</option>
                          <option value="untracked">
                            Don&apos;t track it (another team)
                          </option>
                        </select>
                      )}
                    </div>
                  </th>
                  <td className="num">{off ? "—" : days(planned)}</td>
                  <td className="num">{off ? "—" : days(earnedDays)}</td>
                  <td className="num">
                    {done}/{count}
                  </td>
                </tr>
                {open &&
                  group.issues.map((issue) => {
                    const state = stateOf(issue.key);
                    const progress = earned.perJiraTask.get(issue.key);
                    const unsized = noEstimate(issue.key);
                    const missing = unsized && issue.statusCategory !== "done";
                    return (
                      <tr
                        key={issue.key}
                        className={
                          "task-row " +
                          (off ? "excluded" : state) +
                          (missing ? " no-estimate" : "")
                        }
                      >
                        <td className="task-key">
                          <a
                            href={`${baseUrl}/browse/${issue.key}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {issue.key}
                          </a>
                        </td>
                        <td>{issue.summary}</td>
                        <td>
                          <span
                            className={"jira-status " + issue.statusCategory}
                          >
                            {issue.status}
                          </span>
                        </td>
                        {showTeams && (
                          <td>
                            {off ? (
                              <span className="muted">—</span>
                            ) : (
                              <TaskTeamPicker
                                issue={issue}
                                teams={teams!}
                                owner={taskTeams?.get(issue.key)}
                                onChange={onSetTaskTeam}
                              />
                            )}
                          </td>
                        )}
                        <td>
                          {off ? (
                            <span className="muted">Not tracked (epic)</span>
                          ) : state === "mapped" ? (
                            <PlanTaskName
                              task={planTaskNames.get(
                                (taskMap ?? {})[issue.key] as string,
                              )}
                            />
                          ) : (
                            <NewTaskSpecialization
                              issue={issue}
                              value={(addedScope ?? {})[issue.key]}
                              specializations={specializations}
                              onChange={onSetAddedScope}
                            />
                          )}
                        </td>
                        <td className="num">
                          {missing ? (
                            <NoEstimate
                              jiraDays={estimateOf(issue, hoursPerDay).days}
                              onReview={onReviewEstimates}
                            />
                          ) : unsized ? (
                            <span className="no-estimate-cell">
                              <span className="no-estimate-label done">
                                No estimate
                              </span>
                              <span className="no-estimate-hint">
                                already done
                              </span>
                            </span>
                          ) : progress?.plannerTaskId ? (
                            days(progress.plannedDays)
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="num">
                          {progress?.plannerTaskId
                            ? days(progress.earned)
                            : "—"}
                        </td>
                        <td className="num">
                          {issue.statusCategory === "done" ? "Yes" : "No"}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            );
          })}
        </table>
      </div>

      {groups.length === 0 && (
        <p className="muted">
          {(hideDone ? "No open Jira tasks" : "No Jira tasks") +
            (activeSpec
              ? " of this specialization."
              : shownTeams && shownTeams.length > 0
                ? " of the selected teams."
                : hideDone
                  ? "."
                  : " were found under the initiative.")}
        </p>
      )}
      {planOnly.length > 0 && (
        <p className="muted plan-only-tasks">
          Plan tasks with no Jira task mapped to them: {planOnly.join(", ")}
        </p>
      )}
    </section>
  );
}

/** The plan task a Jira task matched by name, with its epic. */
function PlanTaskName({ task }: { task?: { name: string; epic: string } }) {
  if (!task) return <span className="muted">—</span>;
  return (
    <span className="plan-task-name">
      {task.name}
      <span className="plan-task-epic">{task.epic}</span>
    </span>
  );
}

/**
 * A Jira task that is not in the plan: added scope once it has a
 * specialization, unmapped until then. Picking one is the only decision left.
 */
function NewTaskSpecialization({
  issue,
  value,
  specializations,
  onChange,
}: {
  issue: JiraIssue;
  value?: string;
  specializations: readonly string[];
  onChange?: (jiraIssueKey: string, specialization: string) => void;
}) {
  const options = value
    ? [...new Set([value, ...specializations])]
    : [...specializations];
  return (
    <span className="new-task-cell">
      <span className={value ? "added-scope-label" : "unmapped-label"}>
        {value ? "Added scope" : "Unmapped"}
      </span>
      <select
        className={"added-scope-spec" + (value ? "" : " needs-spec")}
        aria-label={`Specialization for ${issue.key} ${issue.summary}`}
        value={value ?? ""}
        disabled={!onChange}
        onChange={(e) => {
          if (e.target.value) onChange?.(issue.key, e.target.value);
        }}
      >
        {!value && (
          <option value="" disabled>
            Pick specialization…
          </option>
        )}
        {options.map((spec) => (
          <option key={spec} value={spec}>
            {spec}
          </option>
        ))}
      </select>
    </span>
  );
}

/**
 * A Jira task's team. "From Jira" is the team it resolved to — its Jira Team
 * field, else its assignee's team, else its epic's — named so you can see it;
 * picking a team pins it.
 */
function TaskTeamPicker({
  issue,
  teams,
  owner,
  onChange,
}: {
  issue: JiraIssue;
  teams: TrackerTeam[];
  owner?: { team: string; source: TaskTeamSource };
  onChange?: (jiraIssueKey: string, team: string | null) => void;
}) {
  const how: Record<TaskTeamSource, string> = {
    set: "",
    jira: "",
    assignee: " (assignee)",
    epic: " (epic)",
  };
  const fromJira = issue.team
    ? `From Jira: ${issue.team}`
    : owner && owner.source !== "set"
      ? `From Jira: ${owner.team}${how[owner.source]}`
      : "From Jira: no team";
  return (
    <select
      className={"task-team" + (owner ? "" : " no-team")}
      aria-label={`Team for ${issue.key} ${issue.summary}`}
      value={owner?.source === "set" ? owner.team : ""}
      disabled={!onChange}
      onChange={(e) => onChange?.(issue.key, e.target.value || null)}
    >
      <option value="">{fromJira}</option>
      {teams.map((t) => (
        <option key={t.name} value={t.name}>
          {t.name}
        </option>
      ))}
    </select>
  );
}

/**
 * The plan task has no estimate. Says what Jira has, because the two cases
 * are fixed in different places: an estimate Jira already has is copied with
 * Review estimates, and one it lacks has to be set in Jira first.
 */
function NoEstimate({
  jiraDays,
  onReview,
}: {
  jiraDays: number;
  onReview?: () => void;
}) {
  return (
    <span className="no-estimate-cell">
      <span className="no-estimate-label">No estimate</span>
      {jiraDays > 0 ? (
        <span className="no-estimate-hint">
          Jira: {days(jiraDays)} d
          {onReview && (
            <>
              {" · "}
              <button
                type="button"
                className="no-estimate-copy"
                onClick={onReview}
              >
                Copy it
              </button>
            </>
          )}
        </span>
      ) : (
        <span className="no-estimate-hint">none in Jira</span>
      )}
    </span>
  );
}
