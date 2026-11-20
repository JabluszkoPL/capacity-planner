import { useMemo, useState } from "react";
import {
  autoStack,
  defaultEstimateDays,
  defaultSprintWindow,
  draftFlags,
  draftSpans,
  resolveWorkers,
  todayISO,
  type JiraIssue,
  type JiraSnapshot,
  type Project,
  type SprintDraft,
  type SprintDraftItem,
  type Team,
  type Tracker,
} from "@planner/core";
import { Button } from "../ui/Button";
import { SprintGantt } from "./SprintGantt";
import { WritebackModal } from "./WritebackModal";
import { days } from "./StatusPanel";
import { useJiraSettings } from "../../lib/useJiraSettings";
import { createJiraTransport } from "../../lib/jiraTransport";

interface SprintPlannerProps {
  tracker: Tracker;
  snapshot: JiraSnapshot;
  project?: Project;
  teams: Team[];
  hoursPerDay: number;
  onChange: (draft: SprintDraft | null) => void;
  onApplied?: (
    applied: {
      issueKey: string;
      at: string;
      startDate: string;
      dueDate: string;
    }[],
  ) => void;
}

/** Issues that can still be planned: anything Jira does not consider done. */
function openIssues(snapshot: JiraSnapshot) {
  // Snapshots saved by older versions have epics without `children`.
  return (snapshot.epics ?? []).map((epic) => ({
    epic,
    issues: (epic.children ?? []).filter((c) => c.statusCategory !== "done"),
  }));
}

export function SprintPlanner({
  tracker,
  snapshot,
  project,
  teams,
  hoursPerDay,
  onChange,
  onApplied,
}: SprintPlannerProps) {
  const settings = useJiraSettings();
  const transport = useMemo(() => createJiraTransport(), []);
  const [filter, setFilter] = useState("");
  const [hideInSprint, setHideInSprint] = useState(false);
  const [writebackOpen, setWritebackOpen] = useState(false);

  // Memoised, not computed inline: a tracker with no draft yet would otherwise
  // get a brand-new object on every render, invalidating every memo below it
  // and re-running the span and flag maths for nothing.
  const draft: SprintDraft = useMemo(
    () =>
      tracker.sprintDraft ?? {
        ...defaultSprintWindow(todayISO()),
        items: [],
      },
    [tracker.sprintDraft],
  );

  const workers = useMemo(
    () => resolveWorkers(teams, project),
    [teams, project],
  );
  const spans = useMemo(() => draftSpans(draft, workers), [draft, workers]);
  const flags = useMemo(
    () => draftFlags(draft, spans, workers),
    [draft, spans, workers],
  );

  const groups = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return openIssues(snapshot)
      .map(({ epic, issues }) => ({
        epic,
        issues: issues.filter((i) => {
          if (hideInSprint && i.sprint) return false;
          if (!needle) return true;
          return (
            i.key.toLowerCase().includes(needle) ||
            i.summary.toLowerCase().includes(needle)
          );
        }),
      }))
      .filter((g) => g.issues.length > 0);
  }, [snapshot, filter, hideInSprint]);

  const selected = new Set(draft.items.map((i) => i.issueKey));

  function update(next: SprintDraft) {
    onChange(next.items.length === 0 ? null : next);
  }

  function toggle(issue: JiraIssue, epicKey: string) {
    if (selected.has(issue.key)) {
      update({
        ...draft,
        items: draft.items.filter((i) => i.issueKey !== issue.key),
      });
      return;
    }
    // Seed the row from Jira and from the plan, so the common case is a tick
    // and nothing else.
    const plannerEpicId = (tracker.epicMap ?? {})[epicKey];
    const plannerEpic = plannerEpicId
      ? project?.epics.find((e) => e.id === plannerEpicId)
      : undefined;
    const byName = issue.assignee
      ? [...workers.values()].find(
          (w) =>
            w.name.trim().toLowerCase() ===
            issue.assignee?.displayName.trim().toLowerCase(),
        )
      : undefined;
    const item: SprintDraftItem = {
      issueKey: issue.key,
      estimateDays: defaultEstimateDays(issue, plannerEpic, hoursPerDay),
      start: draft.start,
      ...(byName ? { memberId: byName.id } : {}),
    };
    update({ ...draft, items: [...draft.items, item] });
  }

  function patch(issueKey: string, changes: Partial<SprintDraftItem>) {
    update({
      ...draft,
      items: draft.items.map((i) =>
        i.issueKey === issueKey ? { ...i, ...changes } : i,
      ),
    });
  }

  const overloaded = [...flags.perMember.entries()].filter(
    ([, m]) => m.overBy > 0,
  );

  const canWrite = settings.allowWrites && transport.canWrite;

  return (
    <section
      className="panel tracking-panel sprint-panel"
      aria-label="Sprint planning"
    >
      <div className="sprint-head">
        <h2 className="panel-title">Sprint</h2>
        <div className="sprint-window">
          <label>
            <span>From</span>{" "}
            <input
              type="date"
              value={draft.start}
              onChange={(e) => update({ ...draft, start: e.target.value })}
            />
          </label>
          <label>
            <span>To</span>{" "}
            <input
              type="date"
              value={draft.end}
              onChange={(e) => update({ ...draft, end: e.target.value })}
            />
          </label>
        </div>
      </div>

      <div className="sprint-actions">
        <input
          type="search"
          aria-label="Filter issues"
          placeholder="Filter issues…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <label className="candidate">
          <input
            type="checkbox"
            checked={hideInSprint}
            onChange={(e) => setHideInSprint(e.target.checked)}
          />
          <span>Hide issues already in a Jira sprint</span>
        </label>
        <span className="spacer" />
        <Button
          small
          disabled={draft.items.length === 0}
          onClick={() => update(autoStack(draft, workers))}
        >
          Auto-stack per person
        </Button>
        <Button
          small
          disabled={draft.items.length === 0}
          onClick={() => onChange(null)}
        >
          Clear draft
        </Button>
        {canWrite && (
          <Button
            small
            variant="primary"
            disabled={draft.items.length === 0}
            onClick={() => setWritebackOpen(true)}
          >
            Apply dates to Jira…
          </Button>
        )}
      </div>

      <div className="sprint-candidates" role="group" aria-label="Open issues">
        {groups.length === 0 && (
          <p className="muted">No open issues match that filter.</p>
        )}
        {groups.map(({ epic, issues }) => (
          <div className="candidate-epic" key={epic.key}>
            <h4>
              {epic.key} · {epic.summary}
            </h4>
            {issues.map((issue) => (
              <label className="candidate" key={issue.key}>
                <input
                  type="checkbox"
                  checked={selected.has(issue.key)}
                  onChange={() => toggle(issue, epic.key)}
                />
                <span className="candidate-key">{issue.key}</span>
                <span>{issue.summary}</span>
                {issue.assignee && (
                  <span className="muted">· {issue.assignee.displayName}</span>
                )}
              </label>
            ))}
          </div>
        ))}
      </div>

      {draft.items.length > 0 && (
        <>
          <div className="table-scroll">
            <table className="sprint-table">
              <thead>
                <tr>
                  <th scope="col">Issue</th>
                  <th scope="col">Assignee</th>
                  <th scope="col">Estimate</th>
                  <th scope="col">Start</th>
                  <th scope="col">Due</th>
                  <th scope="col">Flags</th>
                </tr>
              </thead>
              <tbody>
                {draft.items.map((item) => {
                  const span = spans.get(item.issueKey);
                  const flag = flags.perItem.get(item.issueKey);
                  return (
                    <tr key={item.issueKey}>
                      <td>
                        <span className="candidate-key">{item.issueKey}</span>
                      </td>
                      <td>
                        <select
                          aria-label={`Assignee for ${item.issueKey}`}
                          value={item.memberId ?? ""}
                          onChange={(e) =>
                            patch(item.issueKey, {
                              memberId: e.target.value || undefined,
                            })
                          }
                        >
                          <option value="">Unassigned</option>
                          {[...workers.values()].map((w) => (
                            <option key={w.id} value={w.id}>
                              {w.name}
                              {w.specialization ? ` (${w.specialization})` : ""}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="num">
                        <input
                          type="number"
                          min={0.5}
                          step={0.5}
                          aria-label={`Estimate in days for ${item.issueKey}`}
                          value={item.estimateDays}
                          onChange={(e) =>
                            patch(item.issueKey, {
                              estimateDays: Number(e.target.value) || 0,
                            })
                          }
                        />
                      </td>
                      <td>
                        <input
                          type="date"
                          aria-label={`Start date for ${item.issueKey}`}
                          value={item.start}
                          onChange={(e) =>
                            patch(item.issueKey, { start: e.target.value })
                          }
                        />
                      </td>
                      <td>{span?.end ?? "—"}</td>
                      <td>
                        {flag?.overflowsSprint && (
                          <span className="row-flag overflow">
                            Won't finish in sprint
                          </span>
                        )}
                        {flag?.unassigned && (
                          <span className="row-flag unassigned">
                            No assignee
                          </span>
                        )}
                        {item.applied && (
                          <span className="row-flag">In Jira</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {overloaded.length > 0 && (
            <p className="capacity-warning" role="status">
              Over capacity:{" "}
              {overloaded
                .map(([id, m]) => {
                  const name = workers.get(id)?.name ?? id;
                  return `${name} by ${days(m.overBy)} d`;
                })
                .join(", ")}
            </p>
          )}

          <SprintGantt
            draft={draft}
            spans={spans}
            snapshot={snapshot}
            workers={workers}
            teams={teams}
            project={project}
            epicMap={tracker.epicMap}
          />
        </>
      )}

      {writebackOpen && (
        <WritebackModal
          open={writebackOpen}
          onClose={() => setWritebackOpen(false)}
          items={draft.items}
          spans={spans}
          snapshot={snapshot}
          baseUrl={tracker.baseUrl}
          settings={settings}
          transport={transport}
          onApplied={(applied) => onApplied?.(applied)}
        />
      )}
    </section>
  );
}
