import {
  type Assignment,
  type Team,
  colorFor,
  teamSpecTotals,
} from "@planner/core";

interface TeamBreakdownProps {
  assignments: Assignment[];
  teams: Team[];
}

/**
 * Planned working days rolled up per team and per specialization, with project
 * helpers grouped separately under "External". Complements the per-person
 * utilization cards: each group's total is the sum of its members' planned
 * days (ceil(estimateDays) per assignment).
 */
export function TeamBreakdown({ assignments, teams }: TeamBreakdownProps) {
  const groups = teamSpecTotals(assignments, teams);
  if (groups.length === 0) return null;

  return (
    <div className="team-breakdown">
      <h3 className="team-breakdown-title">Planned days by team</h3>
      <div className="tb-groups">
        {groups.map((g) => (
          <div
            key={g.key}
            className={"tb-group" + (g.external ? " tb-external" : "")}
          >
            <div className="tb-group-head">
              <span className="tb-group-name">{g.label}</span>
              <span className="tb-group-total">{g.total}d</span>
            </div>
            <ul className="tb-specs">
              {g.specs.map((s) => (
                <li key={s.specialization} className="tb-spec">
                  <span
                    className="tb-swatch"
                    style={{ background: colorFor(s.specialization) }}
                    aria-hidden="true"
                  />
                  <span className="tb-spec-name" title={s.specialization}>
                    {s.specialization}
                  </span>
                  <span className="tb-spec-days">{s.days}d</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
