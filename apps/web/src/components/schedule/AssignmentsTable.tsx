import { type Assignment, colorFor } from "@planner/core";

import { ColorTag } from "../ui/Badge";
import { Panel } from "../ui/Panel";
import { formatShortDate } from "./DateGrid";

/** Trim floating-point noise from a day count (buffer padding can produce
 *  values like 7.199999999999999) — at most 2 decimals, no trailing zeros. */
function fmtDays(n: number): string {
  return Number(n.toFixed(2)).toString();
}

interface AssignmentsTableProps {
  assignments: Assignment[];
}

export function AssignmentsTable({ assignments }: AssignmentsTableProps) {
  const sorted = assignments
    .slice()
    .sort((a, b) => a.start.localeCompare(b.start));
  return (
    <Panel
      className="assignments-panel"
      title="Assignments"
      subtitle={`${sorted.length} task${sorted.length === 1 ? "" : "s"}, by start date`}
      flush
    >
      <div className="table-scroll">
        <table className="data-table assignments-table">
          <thead>
            <tr>
              <th>Task</th>
              <th>Epic</th>
              <th>Assignee</th>
              <th>Specialization</th>
              <th
                className="num"
                title="Estimate → whole working days blocked out (rounded up)"
              >
                Days
              </th>
              <th>Start</th>
              <th>End</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((a) => (
              <tr key={a.taskId}>
                <td className="assignment-task">{a.taskName}</td>
                <td className="muted">{a.epicName}</td>
                <td>{a.memberName}</td>
                <td>
                  <ColorTag color={colorFor(a.specialization)}>
                    {a.specialization}
                  </ColorTag>
                </td>
                <td className="num">
                  {fmtDays(a.estimateDays)}
                  {a.workDays !== a.estimateDays && (
                    <span
                      className="muted"
                      title={`Rounded up to ${a.workDays} whole working day${a.workDays === 1 ? "" : "s"}`}
                    >
                      {" → "}
                      {a.workDays}
                    </span>
                  )}
                </td>
                <td className="date-cell">{formatShortDate(a.start)}</td>
                <td className="date-cell">{formatShortDate(a.end)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
