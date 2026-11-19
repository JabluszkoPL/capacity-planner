import type { TrackerTeam } from "@planner/core";

interface TeamSelectorProps {
  /** The tracker's teams, from Jira's Team field (`trackerTeams` in core). */
  teams: TrackerTeam[];
  /** The tracker's selection, by name; absent or empty = every team. */
  selected?: string[];
  /** Every team ticked is stored as no selection (`[]`). */
  onChange: (teamNames: string[]) => void;
}

const key = (name: string) => name.trim().toLowerCase();

/**
 * Which teams' work the reading covers: one team alone, or several merged.
 *
 * Checkboxes rather than a single select, because merging is the point: tick
 * Stars alone to see whether Stars is late, tick Stars and Bulls to see the
 * initiative as a whole. At least one stays ticked — a reading of nobody's
 * work means nothing — so the last one cannot be unticked.
 */
export function TeamSelector({ teams, selected, onChange }: TeamSelectorProps) {
  const names = teams.map((t) => t.name);
  const picked = new Set((selected ?? []).map(key));
  const anyPicked = names.some((n) => picked.has(key(n)));
  const isOn = (name: string) => !anyPicked || picked.has(key(name));
  const onCount = names.filter(isOn).length;
  const toggle = (name: string, on: boolean) => {
    const next = names.filter((n) => (n === name ? on : isOn(n)));
    onChange(next.length === names.length ? [] : next);
  };
  return (
    <fieldset className="team-selector">
      <legend>Teams in this reading</legend>
      {teams.map((team) => {
        const on = isOn(team.name);
        return (
          <label key={team.name}>
            <input
              type="checkbox"
              checked={on}
              disabled={on && onCount === 1}
              onChange={(e) => toggle(team.name, e.target.checked)}
            />
            {team.name}
            <span className="muted">
              {team.tasks} task{team.tasks === 1 ? "" : "s"}
            </span>
          </label>
        );
      })}
      <span className="muted">
        {onCount === names.length
          ? "All teams, merged."
          : "Only the ticked teams' Jira tasks, plan work and people."}
      </span>
    </fieldset>
  );
}
