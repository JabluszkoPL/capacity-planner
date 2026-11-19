import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { type Team, allMembers } from "@planner/core";
import { useAppStore } from "@planner/client-runtime";

import { MemberList } from "../components/team/MemberList";
import { AddMemberForm } from "../components/team/AddMemberForm";
import { AvailabilityGrid } from "../components/team/AvailabilityGrid";
import { JiraTeamsModal } from "../components/team/JiraTeamsModal";
import { Button } from "../components/ui/Button";
import { IconButton } from "../components/ui/IconButton";
import { useConfirm } from "../components/ui/ConfirmDialog";
import "../components/team/team.css";
import "../components/team/availability.css";

/**
 * Team page. Lists every team (roster + add form per team) with controls to
 * create and remove teams, then the shared availability grid across all teams.
 * Teams are made by hand or added from Jira; once here, both kinds are edited
 * the same way.
 */
export function TeamPage() {
  const { state, actions } = useAppStore();
  const teams = state.teams;
  const [jiraOpen, setJiraOpen] = useState(false);

  // Live set of specializations in use across every team, feeding the datalist.
  const specs = useMemo(() => {
    const set = new Set<string>();
    for (const m of allMembers(teams)) {
      const s = m.specialization.trim();
      if (s) set.add(s);
    }
    return Array.from(set);
  }, [teams]);

  return (
    <main className="page">
      <div className="team-page-head">
        <h1 className="page-title">Teams</h1>
        <div className="team-page-actions">
          <Button small onClick={() => setJiraOpen(true)}>
            Add from Jira…
          </Button>
          <Button
            variant="primary"
            small
            onClick={() => actions.addTeam("New team")}
          >
            + Add team
          </Button>
        </div>
      </div>
      <JiraTeamsModal open={jiraOpen} onClose={() => setJiraOpen(false)} />

      <datalist id="spec-list">
        {specs.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>

      {teams.map((team) => (
        <TeamCard key={team.id} team={team} canDelete={teams.length > 1} />
      ))}

      <AvailabilityGrid />
    </main>
  );
}

function TeamCard({ team, canDelete }: { team: Team; canDelete: boolean }) {
  const { actions } = useAppStore();
  const confirm = useConfirm();
  const [name, setName] = useState(team.name);
  useEffect(() => setName(team.name), [team.name]);

  const commitName = () => {
    const next = name.trim();
    if (next && next !== team.name) actions.renameTeam(team.id, next);
    else if (!next) setName(team.name); // don't allow a blank team name
  };
  const onNameKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.currentTarget.blur();
    }
  };

  const handleDelete = async () => {
    const ok = await confirm({
      title: "Delete team",
      message: `Delete team "${team.name}" and its ${team.members.length} member(s)? Their project assignments will be cleared.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (ok) actions.deleteTeam(team.id);
  };

  return (
    <div className="card">
      <div className="team-card-head">
        <input
          type="text"
          className="team-name-input"
          aria-label="Team name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={onNameKey}
        />
        {team.jira && (
          <span
            className="jira-badge"
            title={`Added from the Jira team “${team.jira.teamName}” on ${hostOf(team.jira.baseUrl)}${team.jira.syncedAt ? `, last updated ${team.jira.syncedAt.slice(0, 10)}` : ""}. Use “Add from Jira…” to bring in new people.`}
          >
            From Jira
            {team.jira.teamName !== team.name ? ` · ${team.jira.teamName}` : ""}
          </span>
        )}
        <span className="team-meta muted">{team.members.length} members</span>
        {canDelete && (
          <IconButton
            danger
            label={`Delete team ${team.name}`}
            onClick={handleDelete}
          >
            ✕
          </IconButton>
        )}
      </div>
      <MemberList members={team.members} />
      <AddMemberForm
        idSuffix={"-" + team.id}
        onAdd={(name, spec) => actions.addTeamMember(team.id, name, spec)}
      />
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
