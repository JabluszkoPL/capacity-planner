import {
  type Assignment,
  type Team,
  colorFor,
  teamSpecTotals,
} from "@planner/core";

import { ColorTag } from "../ui/Badge";
import { Panel } from "../ui/Panel";

interface TeamBreakdownProps {
  assignments: Assignment[];
  teams: Team[];
}

/**
 * Planned working days rolled up per team and per specialization, with project
 * helpers grouped separately under "External". Complements the per-person
 * utilization bars: each group's total is the sum of its members' planned
 * days (ceil(estimateDays) per assignment).
 */
export function TeamBreakdown({ assignments, teams }: TeamBreakdownProps) {
  const groups = teamSpecTotals(assignments, teams);
  if (groups.length === 0) return null;

  return (
    <Panel className="team-breakdown" title="Planned days by team" flush>
      <div className="table-scroll">
        <table className="data-table tb-table">
          <thead>
            <tr>
              <th>Team / specialization</th>
              <th className="num">Days</th>
            </tr>
          </thead>
          {groups.map((g) => (
            <tbody
              key={g.key}
              className={"tb-group" + (g.external ? " tb-external" : "")}
            >
              <tr className="tb-group-row">
                <th scope="rowgroup" className="tb-group-name">
                  {g.label}
                </th>
                <td className="num tb-group-total">{g.total}d</td>
              </tr>
              {g.specs.map((s) => (
                <tr key={s.specialization} className="tb-spec">
                  <td className="tb-spec-name">
                    <ColorTag
                      color={colorFor(s.specialization)}
                      title={s.specialization}
                    >
                      {s.specialization}
                    </ColorTag>
                  </td>
                  <td className="num tb-spec-days">{s.days}d</td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
    </Panel>
  );
}
