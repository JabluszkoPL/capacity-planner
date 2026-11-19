import type { Assignment, Team } from "./types";
import { findMemberTeam } from "./teams";

/** Planned days for one specialization within a group. */
export interface SpecTotal {
  specialization: string;
  days: number;
}

/** A team's (or the externals') planned-day totals, broken out by spec. */
export interface GroupTotal {
  /** Stable key: the team id, or {@link EXTERNAL_KEY} for helpers. */
  key: string;
  label: string;
  /** True for the external-helpers group (members belong to no team). */
  external: boolean;
  total: number;
  specs: SpecTotal[];
}

/** Group key / label used for project helpers (who belong to no team). */
export const EXTERNAL_KEY = "__external__";
const EXTERNAL_LABEL = "External";
/** Spec label for an assignment whose specialization is blank. */
const NO_SPEC_LABEL = "—";

/**
 * Aggregate planned working days by team and by specialization.
 *
 * Each assignment contributes `ceil(estimateDays)` — the same per-assignment
 * figure the per-person utilization cards use, so a team's total reconciles
 * with the sum of its members' cards. An assignment is bucketed under its
 * member's team, or under a single "External" group when the member id belongs
 * to no team (project {@link Helper}s always land here, since their ids are
 * team-less by construction).
 *
 * Groups come back in `teams` order with External last; specializations within
 * a group are sorted by days descending, then name. Groups with no assignments
 * are omitted entirely.
 */
export function teamSpecTotals(
  assignments: Assignment[],
  teams: Team[],
): GroupTotal[] {
  const groups = new Map<
    string,
    { label: string; external: boolean; specs: Map<string, number> }
  >();

  for (const a of assignments) {
    const team = findMemberTeam(teams, a.memberId);
    const key = team ? team.id : EXTERNAL_KEY;
    let g = groups.get(key);
    if (!g) {
      g = {
        label: team ? team.name : EXTERNAL_LABEL,
        external: !team,
        specs: new Map(),
      };
      groups.set(key, g);
    }
    const spec = a.specialization.trim() || NO_SPEC_LABEL;
    const days = Math.ceil(Number(a.estimateDays) || 0);
    g.specs.set(spec, (g.specs.get(spec) ?? 0) + days);
  }

  const teamOrder = new Map<string, number>();
  teams.forEach((t, i) => teamOrder.set(t.id, i));

  return [...groups.entries()]
    .sort(([ka], [kb]) => {
      const extA = ka === EXTERNAL_KEY;
      const extB = kb === EXTERNAL_KEY;
      if (extA !== extB) return extA ? 1 : -1; // externals always last
      return (teamOrder.get(ka) ?? 0) - (teamOrder.get(kb) ?? 0);
    })
    .map(([key, g]) => {
      const specs: SpecTotal[] = [...g.specs.entries()]
        .map(([specialization, days]) => ({ specialization, days }))
        .sort(
          (x, y) =>
            y.days - x.days || x.specialization.localeCompare(y.specialization),
        );
      const total = specs.reduce((s, x) => s + x.days, 0);
      return { key, label: g.label, external: g.external, total, specs };
    });
}
