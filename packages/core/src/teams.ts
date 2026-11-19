import type { ID, OffDayMap, Project, Team, TeamMember } from "./types";

/**
 * Helpers for working with the app's list of teams as one flat roster.
 *
 * Member ids are globally unique across every team, so downstream consumers
 * that only care about "all people" (member lists, the availability grid) or
 * "everyone's off-days" (the Gantt / export renderers, which key purely off
 * `Assignment.memberId`) can use these instead of reaching into a single team.
 * Only the scheduler needs the per-team structure itself.
 */

/** Every member across every team, in team order then member order. */
export function allMembers(teams: Team[]): TeamMember[] {
  return teams.flatMap((t) => t.members);
}

/**
 * The teams that participate in a project, mirroring the scheduler's rule:
 * absent `teamInclusions` means every team participates (the legacy default);
 * an explicit list (including an empty one) means only the listed teams do.
 * New projects start with an empty list, so nothing participates until a team
 * is selected on the project.
 */
export function includedTeams(project: Project, teams: Team[]): Team[] {
  const inclusions = project.teamInclusions;
  if (!inclusions) return teams;
  const ids = new Set(inclusions.map((i) => i.teamId));
  return teams.filter((t) => ids.has(t.id));
}

/**
 * Every member of the teams participating in a project. Project-level member
 * lists (start dates, epic ownership) use this so selecting or deselecting a
 * team on the project immediately changes whose members appear.
 */
export function includedMembers(project: Project, teams: Team[]): TeamMember[] {
  return allMembers(includedTeams(project, teams));
}

/** One off-day map merged across every team (ids don't collide). */
export function mergedOffDays(teams: Team[]): OffDayMap {
  const merged: OffDayMap = {};
  for (const team of teams) {
    for (const [memberId, days] of Object.entries(team.offDays)) {
      merged[memberId] = days;
    }
  }
  return merged;
}

/** The team a member belongs to, or undefined if the id isn't found. */
export function findMemberTeam(teams: Team[], memberId: ID): Team | undefined {
  return teams.find((t) => t.members.some((m) => m.id === memberId));
}

/**
 * The specializations to suggest when editing a project's tasks and helpers:
 * those held by members of the participating teams, plus the project's own
 * helpers. When no team participates yet, every team's specializations are
 * offered instead, so a fresh project still gets suggestions.
 *
 * Deduplicated case-insensitively — the scheduler matches that way, so
 * "Backend" and "backend" are one option — keeping the first spelling seen.
 */
export function projectSpecializations(
  project: Project,
  teams: Team[],
): string[] {
  const included = includedTeams(project, teams);
  const people = [
    ...allMembers(included.length > 0 ? included : teams),
    ...(project.helpers ?? []),
  ];
  const seen = new Map<string, string>();
  for (const p of people) {
    const s = p.specialization.trim();
    if (s && !seen.has(s.toLowerCase())) seen.set(s.toLowerCase(), s);
  }
  return Array.from(seen.values());
}
