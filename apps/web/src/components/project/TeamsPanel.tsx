import type { Project, Team } from "@planner/core";
import { useAppStore } from "@planner/client-runtime";
import { EmptyState } from "../ui/EmptyState";
import "./project.css";

interface TeamsPanelProps {
  project: Project;
}

/**
 * Per-project team participation. By default every team works the whole project
 * (no `teamInclusions`). Here you can drop a team out, or constrain an included
 * team two combinable ways:
 *  - **Epics**: limit the team to chosen epics; "Only this team" then reserves
 *    those epics to it (others locked out), otherwise others may still help.
 *  - **Time window**: the team only works between the given dates.
 */
export function TeamsPanel({ project }: TeamsPanelProps) {
  const { state, actions } = useAppStore();
  const teams = state.teams;
  const inclusions = project.teamInclusions;

  return (
    <section className="helpers-panel">
      <div className="section-head">
        <h2 className="section-title">Teams on this project</h2>
      </div>
      <p className="muted helpers-intro">
        Every team works the whole project by default. Turn a team off to
        exclude it, or scope an included team to specific epics and/or a time
        window.
      </p>

      {teams.length === 0 ? (
        <EmptyState
          compact
          title="No teams"
          message="Create a team on the Team page first."
        />
      ) : (
        <div className="teams-panel-list">
          {teams.map((team) => {
            const included = inclusions
              ? inclusions.some((i) => i.teamId === team.id)
              : true;
            const inc = inclusions?.find((i) => i.teamId === team.id);
            return (
              <TeamInclusionRow
                key={team.id}
                project={project}
                team={team}
                included={included}
                epicIds={inc?.epicIds ?? []}
                exclusive={inc?.exclusive ?? false}
                availableFrom={inc?.availableFrom ?? ""}
                availableTo={inc?.availableTo ?? ""}
                velocity={inc?.velocity ?? 1}
                onToggleIncluded={() =>
                  actions.toggleTeamIncluded(project.id, team.id)
                }
                onToggleEpic={(epicId) =>
                  actions.toggleTeamInclusionEpic(project.id, team.id, epicId)
                }
                onExclusive={(value) =>
                  actions.updateTeamInclusion(project.id, team.id, {
                    exclusive: value,
                  })
                }
                onWindow={(patch) =>
                  actions.updateTeamInclusion(project.id, team.id, patch)
                }
                onVelocity={(value) =>
                  actions.updateTeamInclusion(project.id, team.id, {
                    velocity: value,
                  })
                }
              />
            );
          })}
        </div>
      )}
    </section>
  );
}

interface RowProps {
  project: Project;
  team: Team;
  included: boolean;
  epicIds: string[];
  exclusive: boolean;
  availableFrom: string;
  availableTo: string;
  velocity: number;
  onToggleIncluded: () => void;
  onToggleEpic: (epicId: string) => void;
  onExclusive: (value: boolean) => void;
  onWindow: (patch: { availableFrom?: string; availableTo?: string }) => void;
  onVelocity: (value: number | undefined) => void;
}

function TeamInclusionRow({
  project,
  team,
  included,
  epicIds,
  exclusive,
  availableFrom,
  availableTo,
  velocity,
  onToggleIncluded,
  onToggleEpic,
  onExclusive,
  onWindow,
  onVelocity,
}: RowProps) {
  const scoped = epicIds.length > 0;
  return (
    <div className={"team-inc-row" + (included ? "" : " excluded")}>
      <label className="team-inc-head">
        <input
          type="checkbox"
          checked={included}
          onChange={onToggleIncluded}
          aria-label={`Include ${team.name} in this project`}
        />
        <span className="team-inc-name">{team.name}</span>
        <span className="muted">{team.members.length} members</span>
      </label>

      {included && (
        <div className="team-inc-config">
          <div className="epic-assign">
            <span className="epic-assign-label">Epics:</span>
            <div className="epic-assign-chips">
              {project.epics.length === 0 && (
                <span className="muted">No epics yet</span>
              )}
              {project.epics.map((e) => {
                const on = epicIds.includes(e.id);
                return (
                  <button
                    key={e.id}
                    type="button"
                    className={"assign-chip " + (on ? "on" : "off")}
                    aria-pressed={on}
                    aria-label={`${on ? "Remove" : "Add"} epic ${e.name} ${
                      on ? "from" : "to"
                    } ${team.name}'s scope`}
                    onClick={() => onToggleEpic(e.id)}
                  >
                    {e.name}
                  </button>
                );
              })}
            </div>
            <span className="epic-assign-hint muted">
              {scoped ? "works only these epics" : "works any epic (no scope)"}
            </span>
          </div>

          {scoped && (
            <label className="team-inc-check">
              <input
                type="checkbox"
                checked={exclusive}
                onChange={(e) => onExclusive(e.target.checked)}
              />
              Only this team (reserve these epics — others can&apos;t help)
            </label>
          )}

          <div className="team-inc-window">
            <span className="epic-assign-label">Time window:</span>
            <label className="team-inc-date">
              From
              <input
                type="date"
                value={availableFrom}
                aria-label={`${team.name} available from`}
                onChange={(e) =>
                  onWindow({ availableFrom: e.target.value || undefined })
                }
              />
            </label>
            <label className="team-inc-date">
              To
              <input
                type="date"
                value={availableTo}
                aria-label={`${team.name} available to`}
                onChange={(e) =>
                  onWindow({ availableTo: e.target.value || undefined })
                }
              />
            </label>
            {(availableFrom || availableTo) && (
              <span className="epic-assign-hint muted">
                only works within this window
              </span>
            )}
          </div>

          <div className="team-inc-velocity">
            <span className="epic-assign-label">Velocity:</span>
            <input
              type="number"
              min={0.1}
              max={2}
              step={0.05}
              value={velocity}
              aria-label={`${team.name} velocity multiplier on this project`}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                onVelocity(Number.isFinite(v) && v !== 1 ? v : undefined);
              }}
            />
            <div className="velocity-presets">
              {[1, 0.9, 0.7].map((v) => (
                <button
                  key={v}
                  type="button"
                  className={"assign-chip " + (velocity === v ? "on" : "off")}
                  aria-pressed={velocity === v}
                  onClick={() => onVelocity(v === 1 ? undefined : v)}
                >
                  {v === 1 ? "1× (default)" : `${v}×`}
                </button>
              ))}
            </div>
            <span className="epic-assign-hint muted">
              {velocity === 1
                ? "works at each member's own speed"
                : velocity < 1
                  ? `${Math.round((1 - velocity) * 100)}% slower here (on top of member speed)`
                  : `${Math.round((velocity - 1) * 100)}% faster here (on top of member speed)`}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
