import { useEffect, useMemo, useState } from "react";
import {
  earnedTaskDays,
  trackedMapping,
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
import { SearchSelect, type SearchSelectOption } from "../ui/SearchSelect";
import { days } from "./StatusPanel";

type SortKey = "order" | "unmatched" | "shortfall";

const NOT_IN_PLAN = "__none__";
/** The specialization filter's value for tasks mapped to no plan task. */
const NO_SPECIALIZATION = "__unmapped__";
const ADDED_SCOPE = "__added__";

interface TasksTableProps {
  snapshot: JiraSnapshot;
  baseUrl: string;
  project: Project;
  taskMap: Tracker["taskMap"];
  onMapTask: (jiraIssueKey: string, plannerTaskId: string | null) => void;
  /** Converts Jira's time estimates to days for the no-estimate hint. */
  hoursPerDay?: number;
  /** Opens the estimate review, offered on a task Jira has an estimate for. */
  onReviewEstimates?: () => void;
  /** Jira issues counted as added scope, with the specialization doing each. */
  addedScope?: Tracker["addedScope"];
  /** Specializations to pick from for added scope; the first is the default. */
  specializations?: readonly string[];
  /** Mark an issue as added scope for `specialization`, or unmark it (null). */
  onSetAddedScope?: (
    jiraIssueKey: string,
    specialization: string | null,
  ) => void;
  /** Jira epics left out as another team's work. */
  untrackedEpics?: Tracker["untrackedEpics"];
  /** Track a whole Jira epic, or leave it out as another team's (false). */
  onSetEpicTracked?: (jiraEpicKey: string, tracked: boolean) => void;
  /**
   * The tracker's teams, when there is more than one: each Jira task then
   * shows the team it belongs to, from Jira or set by hand.
   */
  teams?: TrackerTeam[];
  /** Each Jira task's team, as core works it out (`jiraTaskTeams`). */
  taskTeams?: Map<string, { team: string; source: TaskTeamSource }>;
  /** Set a Jira task's team by hand, or go back to Jira's (null). */
  onSetTaskTeam?: (jiraIssueKey: string, team: string | null) => void;
}

type MappingState = "mapped" | "excluded" | "undecided" | "added";

function mappingState(
  taskMap: Tracker["taskMap"],
  addedScope: Tracker["addedScope"],
  key: string,
): MappingState {
  if ((addedScope ?? {})[key]) return "added";
  const map = taskMap ?? {};
  if (!Object.prototype.hasOwnProperty.call(map, key)) return "undecided";
  return map[key] === null ? "excluded" : "mapped";
}

/**
 * The specialization an added task most likely needs: one named as a whole
 * word in its summary ("[QA] Integration test"), else the first one there is.
 */
function guessSpecialization(
  summary: string,
  specializations: readonly string[],
): string | null {
  const words = new Set(
    summary
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean),
  );
  return (
    specializations.find((s) => words.has(s.trim().toLowerCase())) ??
    specializations[0] ??
    null
  );
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
  onMapTask,
  hoursPerDay,
  onReviewEstimates,
  addedScope,
  specializations = [],
  onSetAddedScope,
  untrackedEpics,
  onSetEpicTracked,
  teams,
  taskTeams,
  onSetTaskTeam,
}: TasksTableProps) {
  const showTeams = (teams?.length ?? 0) > 1;
  const [sort, setSort] = useState<SortKey>("unmatched");
  // Local UI state, like the sort: "" shows every specialization.
  const [specFilter, setSpecFilter] = useState("");
  // Local UI state, not persisted: which Jira epics show their tasks. Epics
  // start collapsed so a large initiative opens as a compact list, and an
  // epic that appears after a refresh is not in the set, so it starts
  // collapsed too.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const untracked = useMemo(
    () => new Set(untrackedEpics ?? []),
    [untrackedEpics],
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

  // One list shared by every row's picker. Skipped tasks stay selectable: a
  // Jira issue with no estimate maps onto one, and hiding it would make that
  // row read as unmapped.
  const planTaskOptions = useMemo<SearchSelectOption[]>(
    () => [
      { value: "", label: "Unmapped" },
      { value: NOT_IN_PLAN, label: "Not tracked (another team)" },
      ...(onSetAddedScope
        ? [{ value: ADDED_SCOPE, label: "Added scope (our team)" }]
        : []),
      ...project.epics.flatMap((epic) =>
        epic.tasks.map((task) => ({
          value: task.id,
          label: task.excluded ? `${task.name} (skipped)` : task.name,
          group: epic.name,
        })),
      ),
    ],
    [project.epics, onSetAddedScope],
  );

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

  const groups = useMemo(() => {
    const shortfall = (issue: JiraIssue) => {
      const row = earned.perJiraTask.get(issue.key);
      return (row?.plannedDays ?? 0) - (row?.earned ?? 0);
    };
    let list = taskGroups(snapshot);
    if (activeSpec) {
      const wanted = activeSpec === NO_SPECIALIZATION ? null : activeSpec;
      list = list
        .map((group) => ({
          ...group,
          issues: group.issues.filter((i) => specOf(i.key) === wanted),
        }))
        .filter((group) => group.issues.length > 0);
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
      // grouped by status within each category (Done before Cancelled), and
      // tasks marked not tracked sink below everything that counts. The sort
      // is stable, so the order above holds within each status.
      const notTracked = (issue: JiraIssue) =>
        Number(stateOf(issue.key) === "excluded");
      group.issues.sort(
        (a, b) =>
          notTracked(a) - notTracked(b) ||
          (STATUS_RANK[a.statusCategory] ?? 0) -
            (STATUS_RANK[b.statusCategory] ?? 0) ||
          compareStatus(a, b),
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
    // Another team's epics go last in every sort but Jira's own order, so your
    // work reads as one block. The sort is stable: order within each is kept.
    if (sort !== "order") {
      list.sort(
        (a, b) =>
          Number(untracked.has(a.epicKey)) - Number(untracked.has(b.epicKey)),
      );
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
    activeSpec,
    specOf,
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
            Jira tasks are matched to planned tasks by name. Only Jira tasks in
            the Done category count as earned. Added scope is work your team
            took on after planning: it counts, sized by Jira&apos;s estimate,
            and uses up buffer.
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
                  <option value={NO_SPECIALIZATION}>Not mapped</option>
                )}
              </select>
            </label>
          )}
          <label className="epics-sort">
            <span>Sort</span>
            <select
              value={sort}
              onChange={(event) => setSort(event.target.value as SortKey)}
            >
              <option value="unmatched">Unmatched first</option>
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
                className={"task-group" + (off ? " untracked" : "")}
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
                      {onSetEpicTracked && (
                        <select
                          id={epicTrackingId(group.epicKey)}
                          className="epic-tracking"
                          aria-label={`Tracking for epic ${group.epicKey} ${group.epicSummary}`}
                          value={off ? "untracked" : "tracked"}
                          onChange={(e) => {
                            onSetEpicTracked(
                              group.epicKey,
                              e.target.value === "tracked",
                            );
                            setRefocus(group.epicKey);
                          }}
                        >
                          <option value="tracked">Tracked</option>
                          <option value="untracked">
                            Not tracked (another team)
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
                          ) : (
                            <>
                              <SearchSelect
                                aria-label={`Plan task for ${issue.key} ${issue.summary}`}
                                options={planTaskOptions}
                                value={
                                  state === "undecided"
                                    ? ""
                                    : state === "added"
                                      ? ADDED_SCOPE
                                      : state === "excluded"
                                        ? NOT_IN_PLAN
                                        : ((taskMap ?? {})[issue.key] as string)
                                }
                                onChange={(value) => {
                                  if (value === ADDED_SCOPE) {
                                    if (state === "added") return;
                                    const spec = guessSpecialization(
                                      issue.summary,
                                      specializations,
                                    );
                                    if (spec)
                                      onSetAddedScope?.(issue.key, spec);
                                    return;
                                  }
                                  if (state === "added") {
                                    onSetAddedScope?.(issue.key, null);
                                  }
                                  onMapTask(
                                    issue.key,
                                    value === "" || value === NOT_IN_PLAN
                                      ? null
                                      : value,
                                  );
                                }}
                              />
                              {state === "added" && (
                                <select
                                  className="added-scope-spec"
                                  aria-label={`Specialization for ${issue.key} ${issue.summary}`}
                                  value={(addedScope ?? {})[issue.key]}
                                  onChange={(e) =>
                                    onSetAddedScope?.(issue.key, e.target.value)
                                  }
                                >
                                  {[
                                    ...new Set([
                                      (addedScope ?? {})[issue.key],
                                      ...specializations,
                                    ]),
                                  ].map((spec) => (
                                    <option key={spec} value={spec}>
                                      {spec}
                                    </option>
                                  ))}
                                </select>
                              )}
                            </>
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
          {activeSpec
            ? "No Jira tasks of this specialization."
            : "No Jira tasks were found under the initiative."}
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
