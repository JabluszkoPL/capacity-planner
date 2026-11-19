import { useMemo, useState } from "react";
import { secondsToDays } from "@planner/jira";
import {
  earnedDays,
  type EarnedEpicRow,
  type JiraEpic,
  type JiraSnapshot,
  type Project,
  type Tracker,
} from "@planner/core";
import { days } from "./StatusPanel";

type SortKey = "order" | "variance";

interface EpicsTableProps {
  snapshot: JiraSnapshot;
  baseUrl: string;
  hoursPerDay: number;
  /** Absent when no baseline is chosen: the plan columns are then hidden. */
  project?: Project;
  epicMap: Tracker["epicMap"];
  onMapEpic?: (jiraEpicKey: string, plannerEpicId: string | null) => void;
}

/** What the epic's plan mapping is, for styling and for the empty option. */
function mappingState(
  epicMap: Tracker["epicMap"],
  key: string,
): "mapped" | "excluded" | "undecided" {
  const map = epicMap ?? {};
  if (!Object.prototype.hasOwnProperty.call(map, key)) return "undecided";
  return map[key] === null ? "excluded" : "mapped";
}

function completionPct(row: EarnedEpicRow | undefined): string {
  if (!row) return "—";
  return `${Math.round(row.completion * 100)}%`;
}

export function EpicsTable({
  snapshot,
  baseUrl,
  hoursPerDay,
  project,
  epicMap,
  onMapEpic,
}: EpicsTableProps) {
  const [sort, setSort] = useState<SortKey>("order");

  const earned = useMemo(
    () => (project ? earnedDays(project, snapshot, epicMap) : null),
    [project, snapshot, epicMap],
  );

  const rows = useMemo(() => {
    const list = [...(snapshot.epics ?? [])];
    if (sort === "variance" && earned) {
      // Biggest shortfall first: the epics actually driving the variance.
      list.sort((a, b) => {
        const ra = earned.perJiraEpic.get(a.key);
        const rb = earned.perJiraEpic.get(b.key);
        const va = (ra?.plannedDays ?? 0) - (ra?.earned ?? 0);
        const vb = (rb?.plannedDays ?? 0) - (rb?.earned ?? 0);
        return vb - va;
      });
    }
    return list;
  }, [snapshot.epics, sort, earned]);

  const plannedInJira = useMemo(() => {
    if (!project) return [];
    const claimed = new Set<string>();
    for (const value of Object.values(epicMap ?? {})) {
      if (value) claimed.add(value);
    }
    return project.epics.filter((e) => !claimed.has(e.id));
  }, [project, epicMap]);

  const dayCell = (sec: number | undefined) =>
    sec && sec > 0 ? days(secondsToDays(sec, hoursPerDay)) : "—";

  return (
    <section className="epics-section" aria-label="Epics">
      <div className="epics-head">
        <h2 className="section-title">Jira epics</h2>
        {project && (
          <label className="epics-sort">
            <span>Sort</span>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
            >
              <option value="order">Jira order</option>
              <option value="variance">Biggest shortfall</option>
            </select>
          </label>
        )}
      </div>

      <div className="table-scroll">
        <table className="epics-table">
          <thead>
            <tr>
              <th scope="col">Key</th>
              <th scope="col">Epic</th>
              <th scope="col">Status</th>
              <th scope="col">Done</th>
              {project && <th scope="col">Plan epic</th>}
              {project && <th scope="col">Planned</th>}
              {project && <th scope="col">Earned</th>}
              {project && <th scope="col">Complete</th>}
              <th scope="col">Spent</th>
              <th scope="col">Remaining</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((epic: JiraEpic) => {
              const row = earned?.perJiraEpic.get(epic.key);
              const state = mappingState(epicMap, epic.key);
              return (
                <tr key={epic.key} className={"epic-row " + state}>
                  <td>
                    <a
                      href={`${baseUrl}/browse/${epic.key}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {epic.key}
                    </a>
                  </td>
                  <td>{epic.summary}</td>
                  <td>
                    <span className={"jira-status " + epic.statusCategory}>
                      {epic.status}
                    </span>
                  </td>
                  <td className="num">
                    {epic.totals.done}/{epic.totals.all}
                  </td>
                  {project && (
                    <td>
                      <select
                        aria-label={`Plan epic for ${epic.key} ${epic.summary}`}
                        value={
                          state === "undecided"
                            ? ""
                            : state === "excluded"
                              ? "__none__"
                              : ((epicMap ?? {})[epic.key] as string)
                        }
                        onChange={(e) => {
                          const v = e.target.value;
                          onMapEpic?.(
                            epic.key,
                            v === "__none__" || v === "" ? null : v,
                          );
                        }}
                      >
                        <option value="">Unmapped</option>
                        <option value="__none__">Not in plan</option>
                        {project.epics.map((pe) => (
                          <option key={pe.id} value={pe.id}>
                            {pe.name}
                          </option>
                        ))}
                      </select>
                    </td>
                  )}
                  {project && (
                    <td className="num">
                      {row && row.plannerEpicId ? days(row.plannedDays) : "—"}
                    </td>
                  )}
                  {project && (
                    <td className="num">
                      {row && row.plannerEpicId ? days(row.earned) : "—"}
                    </td>
                  )}
                  {project && <td className="num">{completionPct(row)}</td>}
                  <td className="num">{dayCell(epic.totals.spentSec)}</td>
                  <td className="num">{dayCell(epic.totals.remainingSec)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {rows.length === 0 && (
        <p className="muted">
          This initiative has no epics under it, or none your account can see.
        </p>
      )}

      {plannedInJira.length > 0 && (
        <p className="muted plan-only-epics">
          Plan epics with no Jira epic mapped to them:{" "}
          {plannedInJira.map((e) => e.name).join(", ")}
        </p>
      )}
    </section>
  );
}
