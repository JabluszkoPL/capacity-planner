import { type Assignment, colorFor } from "@planner/core";

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
    <div className="table-scroll">
      <table className="assignments-table">
        <thead>
          <tr>
            <th>Task</th>
            <th>Epic</th>
            <th>Assignee</th>
            <th>Specialization</th>
            <th title="Estimate → whole working days blocked out (rounded up)">
              Days
            </th>
            <th>Start</th>
            <th>End</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((a) => {
            const c = colorFor(a.specialization);
            return (
              <tr key={a.taskId}>
                <td>{a.taskName}</td>
                <td className="muted">{a.epicName}</td>
                <td>{a.memberName}</td>
                <td>
                  <span
                    className="spec-badge"
                    style={{ background: c + "22", color: c }}
                  >
                    {a.specialization}
                  </span>
                </td>
                <td>
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
                <td>{formatShortDate(a.start)}</td>
                <td>{formatShortDate(a.end)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
