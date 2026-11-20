import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { type Team, allMembers } from "@planner/core";
import { useAppStore } from "@planner/client-runtime";

import { MemberList } from "../components/team/MemberList";
import { AddMemberForm } from "../components/team/AddMemberForm";
import { AvailabilityGrid } from "../components/team/AvailabilityGrid";
import { JiraTeamsModal } from "../components/team/JiraTeamsModal";
import {
  Badge,
  Button,
  Icon,
  IconButton,
  Page,
  PageHeader,
  Panel,
} from "../components/ui";
import { useConfirm } from "../components/ui/ConfirmDialog";
import "../components/team/team.css";
import "../components/team/availability.css";

const ALL = "all";

/**
 * Teams & availability. Every team is a roster panel (people, their
 * specialization and speed, and an add form), then one availability panel for
 * marking days off. Teams are made by hand or added from Jira; once here, both
 * kinds are edited the same way.
 *
 * With several teams a "Team" filter narrows both the rosters and the grid to
 * one of them. It only ever narrows the view: "All teams" is the default and
 * the page goes back to it whenever a team is added or removed, so a new team
 * never lands out of sight.
 */
export function TeamPage() {
  const { state, actions } = useAppStore();
  const teams = state.teams;
  const [jiraOpen, setJiraOpen] = useState(false);
  const [filter, setFilter] = useState<string>(ALL);

  useEffect(() => setFilter(ALL), [teams.length]);
  const focused = teams.find((t) => t.id === filter);
  const shown = focused ? [focused] : teams;

  // Live set of specializations in use across every team, feeding the datalist.
  const specs = useMemo(() => {
    const set = new Set<string>();
    for (const m of allMembers(teams)) {
      const s = m.specialization.trim();
      if (s) set.add(s);
    }
    return Array.from(set);
  }, [teams]);

  const people = allMembers(teams).length;

  return (
    <Page>
      <PageHeader
        title="Teams & availability"
        subtitle={
          <>
            {plural(teams.length, "team")} ·{" "}
            {plural(people, "person", "people")}
          </>
        }
        actions={
          <>
            <Button icon="jira" onClick={() => setJiraOpen(true)}>
              Add from Jira…
            </Button>
            <Button
              variant="primary"
              icon="plus"
              onClick={() => {
                setFilter(ALL);
                actions.addTeam("New team");
              }}
            >
              Add team
            </Button>
          </>
        }
      >
        {teams.length > 1 && (
          <div className="team-filter">
            <label htmlFor="team-filter">Team</label>
            <select
              id="team-filter"
              value={focused ? focused.id : ALL}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value={ALL}>All teams</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </PageHeader>
      <JiraTeamsModal open={jiraOpen} onClose={() => setJiraOpen(false)} />

      <datalist id="spec-list">
        {specs.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>

      <div className="team-grid">
        {shown.map((team) => (
          <TeamPanel key={team.id} team={team} canDelete={teams.length > 1} />
        ))}
      </div>

      <AvailabilityGrid teamId={focused?.id} />
    </Page>
  );
}

function TeamPanel({ team, canDelete }: { team: Team; canDelete: boolean }) {
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
    <Panel
      className="team-panel"
      aria-label={team.name}
      flush
      icon={<Icon name="users" size={18} />}
      title={
        <input
          type="text"
          className="team-name-input"
          aria-label="Team name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={onNameKey}
        />
      }
      subtitle={
        <span className="team-meta">
          {plural(team.members.length, "person", "people")}
          {team.jira && (
            <Badge
              tone="accent"
              icon={<Icon name="jira" size={11} />}
              title={`Added from the Jira team “${team.jira.teamName}” on ${hostOf(team.jira.baseUrl)}${team.jira.syncedAt ? `, last updated ${team.jira.syncedAt.slice(0, 10)}` : ""}. Use “Add from Jira…” to bring in new people.`}
            >
              From Jira
              {team.jira.teamName !== team.name
                ? ` · ${team.jira.teamName}`
                : ""}
            </Badge>
          )}
        </span>
      }
      actions={
        canDelete && (
          <IconButton
            danger
            label={`Delete team ${team.name}`}
            onClick={handleDelete}
          >
            <Icon name="trash" size={15} />
          </IconButton>
        )
      }
    >
      <MemberList members={team.members} offDays={team.offDays} />
      <AddMemberForm
        idSuffix={"-" + team.id}
        onAdd={(name, spec) => actions.addTeamMember(team.id, name, spec)}
      />
    </Panel>
  );
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
