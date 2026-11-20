import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useAppStore } from "@planner/client-runtime";
import { parseOrgId } from "@planner/jira";
import { colorFor } from "@planner/core";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Badge } from "../ui/Badge";
import { Avatar } from "../ui/IconTile";
import { Callout } from "../ui/Callout";
import { Icon } from "../ui/Icon";
import { useToast } from "../ui/Toast";
import { createJiraTransport } from "../../lib/jiraTransport";
import { isJiraConfigured, writeJiraSettings } from "../../lib/jiraSettings";
import { useJiraSettings } from "../../lib/useJiraSettings";
import {
  importInput,
  loadTeamPeople,
  loadTeamsDirectory,
  previewTeam,
  type TeamRow,
  type TeamsDirectory,
} from "../../lib/jiraTeams";

interface JiraTeamsModalProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Add teams from Jira's Teams tab — Atlassian's Teams directory — with the
 * people already assigned to them there.
 *
 * The body is only mounted while open, so every opening reads the directory
 * afresh rather than showing a roster that may have changed since.
 */
export function JiraTeamsModal({ open, onClose }: JiraTeamsModalProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add teams from Jira"
      subtitle="From Jira's Teams tab, with the people already on each team."
      className="jira-teams"
    >
      <Body onClose={onClose} />
    </Modal>
  );
}

function Body({ onClose }: { onClose: () => void }) {
  const [directory, setDirectory] = useState<TeamsDirectory | null>(null);
  if (!directory) return <LoadStep onLoaded={setDirectory} onClose={onClose} />;
  return (
    <PickStep
      directory={directory}
      onBack={() => setDirectory(null)}
      onClose={onClose}
    />
  );
}

/* ------------------------------- load step ------------------------------- */

function LoadStep({
  onLoaded,
  onClose,
}: {
  onLoaded: (directory: TeamsDirectory) => void;
  onClose: () => void;
}) {
  const settings = useJiraSettings();
  const transport = useMemo(() => createJiraTransport(), []);
  const connected = isJiraConfigured(settings);
  const reachable = transport.kind !== "none";
  const id = useId();
  const [orgId, setOrgId] = useState(settings.orgId ?? "");
  const [askOrg, setAskOrg] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    if (busy) return;
    const typed = orgId.trim();
    const parsed = typed ? parseOrgId(typed) : null;
    if (typed && !parsed) {
      setError("That doesn't look like an organization ID.");
      setAskOrg(true);
      return;
    }
    setError(null);
    setBusy(true);
    const result = await loadTeamsDirectory({
      settings,
      transport,
      orgId: parsed ?? undefined,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      if (result.needsOrgId) setAskOrg(true);
      // Show the id that failed, so it can be compared and corrected.
      if (result.triedOrgId && !orgId.trim()) setOrgId(result.triedOrgId);
      return;
    }
    if (result.orgId !== settings.orgId) {
      writeJiraSettings({ ...settings, orgId: result.orgId });
    }
    if (result.teams.length === 0) {
      setError("This organization has no active teams in Jira's Teams tab.");
      setAskOrg(true);
      return;
    }
    onLoaded(result);
  }

  // Read the directory straight away; the org id is found automatically.
  // Once only: StrictMode runs effects twice in development.
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !connected || !reachable) return;
    started.current = true;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function submit(e: FormEvent) {
    e.preventDefault();
    void load();
  }

  return (
    <form onSubmit={submit}>
      <p className="modal-hint">
        Added teams work like any other: set their timeline per project and
        their days off on this page.
      </p>
      {!connected && (
        <Callout tone="warning">
          Connect Jira first (Tracking → Connect Jira).
        </Callout>
      )}
      {transport.unavailableReason && (
        <Callout tone="warning">{transport.unavailableReason}</Callout>
      )}
      {busy && (
        <p className="jira-teams-status muted" role="status">
          <Icon name="refresh" size={14} className="jira-spin" />
          Reading teams from Jira…
        </p>
      )}
      {error && (
        <Callout tone="danger" role="alert">
          {error}
        </Callout>
      )}
      {askOrg && (
        <div className="field jira-teams-org">
          <label className="modal-field-label" htmlFor={`${id}-org`}>
            Atlassian organization ID
          </label>
          <input
            id={`${id}-org`}
            type="text"
            value={orgId}
            placeholder="Paste the ID or the admin.atlassian.com/o/… link"
            onChange={(e) => {
              setOrgId(e.target.value);
              if (error) setError(null);
            }}
          />
          <p className="muted jira-teams-org-hint">
            Find it at admin.atlassian.com — it is the part after{" "}
            <code>/o/</code> in the address. Planner remembers it on this
            device.
          </p>
        </div>
      )}
      <div className="modal-actions">
        <Button onClick={onClose}>Cancel</Button>
        <Button
          type="submit"
          variant="primary"
          disabled={busy || !connected || !reachable}
        >
          {busy ? "Loading…" : "Load teams"}
        </Button>
      </div>
    </form>
  );
}

/* -------------------------------- pick step ------------------------------- */

type Loaded =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; row: TeamRow };

function PickStep({
  directory,
  onBack,
  onClose,
}: {
  directory: TeamsDirectory;
  onBack: () => void;
  onClose: () => void;
}) {
  const { state, actions } = useAppStore();
  const settings = useJiraSettings();
  const transport = useMemo(() => createJiraTransport(), []);
  const toast = useToast();
  const id = useId();
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [loaded, setLoaded] = useState<Record<string, Loaded>>({});
  const [names, setNames] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState("");

  const visible = directory.teams.filter((t) =>
    t.name.toLowerCase().includes(filter.trim().toLowerCase()),
  );

  async function loadPeople(teamId: string) {
    const team = directory.teams.find((t) => t.id === teamId);
    if (!team) return;
    setLoaded((l) => ({ ...l, [teamId]: { status: "loading" } }));
    const result = await loadTeamPeople({
      settings,
      transport,
      directory,
      teamId,
    });
    setLoaded((l) => ({
      ...l,
      [teamId]: result.ok
        ? {
            status: "ready",
            row: previewTeam(
              team,
              result.people,
              state,
              settings.baseUrl,
              result.source,
            ),
          }
        : { status: "error", message: result.message },
    }));
  }

  function togglePicked(teamId: string) {
    const on = !picked.has(teamId);
    setPicked((s) => {
      const next = new Set(s);
      if (on) next.add(teamId);
      else next.delete(teamId);
      return next;
    });
    const current = loaded[teamId];
    if (on && (!current || current.status === "error")) void loadPeople(teamId);
  }

  const patchPerson = (
    teamId: string,
    accountId: string,
    patch: { selected?: boolean; specialization?: string },
  ) =>
    setLoaded((l) => {
      const entry = l[teamId];
      if (entry?.status !== "ready") return l;
      return {
        ...l,
        [teamId]: {
          status: "ready",
          row: {
            ...entry.row,
            people: entry.row.people.map((p) =>
              p.person.accountId === accountId ? { ...p, ...patch } : p,
            ),
          },
        },
      };
    });

  const chosen: TeamRow[] = [];
  for (const teamId of picked) {
    const entry = loaded[teamId];
    if (entry?.status === "ready") chosen.push(entry.row);
  }
  const stillLoading = [...picked].some((t) => loaded[t]?.status === "loading");

  // Somebody on two Jira teams, ticked on both, would land on whichever is
  // imported first; say so rather than letting the second silently drop them.
  const twice = new Set<string>();
  const seen = new Set<string>();
  for (const r of chosen) {
    for (const p of r.people) {
      if (!p.selected || p.alreadyIn) continue;
      if (seen.has(p.person.accountId)) twice.add(p.person.accountId);
      seen.add(p.person.accountId);
    }
  }

  function commit() {
    const now = new Date().toISOString();
    let created = 0;
    let updated = 0;
    let people = 0;
    for (const row of chosen) {
      const input = importInput(
        row,
        names[row.team.id] ?? row.team.name,
        settings.baseUrl,
        directory.orgId,
        now,
      );
      actions.importJiraTeam(input);
      people += input.members.length;
      if (row.existing) updated += 1;
      else created += 1;
    }
    const parts = [
      created > 0 ? `${plural(created, "team")} added` : "",
      updated > 0 ? `${updated} updated` : "",
    ].filter(Boolean);
    toast(
      `${parts.join(", ")} from Jira — ${plural(people, "person", "people")}.`,
    );
    onClose();
  }

  return (
    <div>
      <p className="modal-hint">
        Tick the teams to add. Anyone already in Planner is skipped. Fill in
        specializations: the scheduler matches tasks by them.
      </p>
      {directory.teams.length > 6 && (
        <input
          type="search"
          className="jira-teams-filter"
          aria-label="Filter teams"
          placeholder={`Filter ${directory.teams.length} teams…`}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      )}
      <ul className="jira-teams-list">
        {visible.map((team) => {
          const on = picked.has(team.id);
          const boxId = `${id}-${team.id}`;
          const entry = loaded[team.id];
          const row = entry?.status === "ready" ? entry.row : undefined;
          return (
            <li key={team.id} className={`jira-team-row${on ? " is-on" : ""}`}>
              <div className="jira-team-head">
                <input
                  id={boxId}
                  type="checkbox"
                  checked={on}
                  onChange={() => togglePicked(team.id)}
                />
                <div className="jira-team-text">
                  <label htmlFor={boxId} className="jira-team-name">
                    {team.name}
                  </label>
                  {team.description && (
                    <p className="muted jira-team-desc">{team.description}</p>
                  )}
                </div>
                {row?.existing && (
                  <Badge tone="accent">Updates “{row.existing.name}”</Badge>
                )}
                {row && (
                  <Badge>{plural(row.people.length, "person", "people")}</Badge>
                )}
              </div>
              {on && entry?.status === "loading" && (
                <p className="jira-teams-status muted" role="status">
                  <Icon name="refresh" size={14} className="jira-spin" />
                  Loading members…
                </p>
              )}
              {on && entry?.status === "error" && (
                <div className="jira-team-body">
                  <Callout
                    tone="danger"
                    role="alert"
                    actions={
                      <Button small onClick={() => void loadPeople(team.id)}>
                        Retry
                      </Button>
                    }
                  >
                    {entry.message}
                  </Callout>
                </div>
              )}
              {on && row && (
                <TeamBody
                  row={row}
                  boxId={boxId}
                  name={names[team.id] ?? team.name}
                  onName={(v) => setNames((n) => ({ ...n, [team.id]: v }))}
                  twice={twice}
                  onPerson={(accountId, patch) =>
                    patchPerson(team.id, accountId, patch)
                  }
                />
              )}
            </li>
          );
        })}
      </ul>
      <div className="modal-actions">
        <Button onClick={onBack}>Back</Button>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="primary"
          disabled={chosen.length === 0 || stillLoading}
          onClick={commit}
        >
          {chosen.length === 0
            ? "Add teams"
            : `Add ${plural(chosen.length, "team")}`}
        </Button>
      </div>
    </div>
  );
}

function TeamBody({
  row,
  boxId,
  name,
  onName,
  twice,
  onPerson,
}: {
  row: TeamRow;
  boxId: string;
  name: string;
  onName: (v: string) => void;
  twice: Set<string>;
  onPerson: (
    accountId: string,
    patch: { selected?: boolean; specialization?: string },
  ) => void;
}) {
  const fresh = row.people.filter((p) => !p.alreadyIn).length;
  return (
    <div className="jira-team-body">
      {!row.existing && (
        <div className="jira-team-rename">
          <label htmlFor={`${boxId}-name`}>Name in Planner</label>
          <input
            id={`${boxId}-name`}
            type="text"
            value={name}
            onChange={(e) => onName(e.target.value)}
          />
        </div>
      )}
      {row.source.kind === "issues" && (
        <div className="jira-team-fallback" role="note">
          <Callout
            tone="warning"
            title="Not the team's roster - the people assigned to its Jira issues."
          >
            {row.source.refusal} So these are everyone assigned an issue with
            Team = {row.team.name}, updated in the last {row.source.sinceDays}{" "}
            days. Untick anyone who isn't on the team; add anyone missing on
            this page afterwards.
          </Callout>
        </div>
      )}
      {row.people.length === 0 ? (
        <p className="muted jira-team-empty">
          {row.source.kind === "issues"
            ? "No recent Jira issues of this team are assigned to anyone."
            : "This team has no members in Jira yet."}
        </p>
      ) : fresh === 0 ? (
        <p className="muted jira-team-empty">
          Everyone on this team is already in Planner.
        </p>
      ) : null}
      {row.people.length > 0 && (
        <table className="data-table jira-people">
          <thead>
            <tr>
              <th scope="col" className="jira-people-check">
                Add
              </th>
              <th scope="col">Person</th>
              {row.source.kind === "issues" && (
                <th scope="col" className="num">
                  Issues
                </th>
              )}
              <th scope="col">Specialization</th>
            </tr>
          </thead>
          <tbody>
            {row.people.map((p) => {
              const pid = `${boxId}-${p.person.accountId}`;
              return (
                <tr
                  key={p.person.accountId}
                  className={p.alreadyIn ? "is-already" : undefined}
                >
                  <td className="jira-people-check">
                    <input
                      id={pid}
                      type="checkbox"
                      checked={p.selected && !p.alreadyIn}
                      disabled={!!p.alreadyIn}
                      onChange={(e) =>
                        onPerson(p.person.accountId, {
                          selected: e.target.checked,
                        })
                      }
                    />
                  </td>
                  <td>
                    <span className="jira-person">
                      <Avatar
                        name={p.person.displayName}
                        color={colorFor(p.specialization)}
                        size="sm"
                      />
                      <label htmlFor={pid}>{p.person.displayName}</label>
                    </span>
                    {p.alreadyIn && (
                      <span className="jira-person-note muted">
                        already in {p.alreadyIn.name}
                      </span>
                    )}
                    {twice.has(p.person.accountId) && p.selected && (
                      <span className="jira-person-note jira-twice">
                        ticked on another team too
                      </span>
                    )}
                  </td>
                  {row.source.kind === "issues" && (
                    <td className="num">{p.person.issueCount ?? 0}</td>
                  )}
                  <td>
                    {!p.alreadyIn && (
                      <input
                        type="text"
                        className="jira-spec-input"
                        list="spec-list"
                        aria-label={`Specialization of ${p.person.displayName}`}
                        placeholder="e.g. Backend"
                        value={p.specialization}
                        onChange={(e) =>
                          onPerson(p.person.accountId, {
                            specialization: e.target.value,
                          })
                        }
                      />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
