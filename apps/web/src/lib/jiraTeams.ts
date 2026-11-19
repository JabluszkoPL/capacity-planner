/**
 * Bringing the teams from Jira's Teams tab onto the Team page.
 *
 * `@planner/jira` reads Atlassian's Teams directory (the teams and who is on
 * each); this file decides what importing them means *here*:
 *
 *  - **The organization id is found once and remembered.** The Teams API is
 *    scoped by it. It is looked up from the site's host name the first time
 *    and kept in this device's Jira settings; when the lookup is not allowed
 *    the user pastes it (from admin.atlassian.com) instead.
 *  - **One team per person.** Member ids are globally unique and a person on
 *    two teams would be scheduled twice, so somebody already on any Planner
 *    team is shown but not offered.
 *  - **A team imported once is updated, not duplicated.** A Planner team that
 *    came from the same Atlassian team is the target; importing again only
 *    adds people who are new to it.
 *  - **Specializations are guessed, then editable.** The scheduler needs one
 *    per person and the directory has no such field, so the guess is the
 *    specialization of a same-named person already in Planner, else blank.
 *
 * After import the team is an ordinary Planner team: its timeline per project
 * (team inclusion windows) and its people's days off are edited exactly as
 * for a team made by hand.
 */
import {
  allMembers,
  type AppState,
  type JiraTeamSource,
  type Team,
} from "@planner/core";
import {
  basicAuth,
  fetchJiraTenant,
  fetchTeamDirectory,
  fetchTeamIssuePeople,
  fetchTeamMembers,
  TEAM_ISSUE_WINDOW_DAYS,
  JiraError,
  type JiraDirectoryPerson,
  type JiraDirectoryTeam,
  type JiraTransport,
} from "@planner/jira";
import { JiraUnavailableError } from "./jiraTransport";
import { isJiraConfigured, type JiraSettings } from "./jiraSettings";

/* ------------------------------- loading -------------------------------- */

function unavailableOf(err: unknown): JiraUnavailableError | null {
  if (err instanceof JiraUnavailableError) return err;
  if (err instanceof JiraError && err.cause instanceof JiraUnavailableError) {
    return err.cause;
  }
  return null;
}

/** Atlassian's own words after the status, e.g. ": Not allowed (FORBIDDEN)". */
function detail(err: JiraError): string {
  const i = err.message.indexOf("): ");
  return i === -1 ? "" : ` — ${err.message.slice(i + 3)}`;
}

function describe(err: unknown, what: string): string {
  const unavailable = unavailableOf(err);
  if (unavailable) return unavailable.message;
  if (err instanceof JiraError) {
    const onTeams = err.requestPath?.startsWith("/gateway/api/public/teams/");
    switch (err.kind) {
      case "auth":
        if (err.status === 401) {
          return "Jira rejected your email and token. Check them in Jira settings.";
        }
        if (!onTeams) {
          return `Jira accepted your email and token, but denied ${what}.`;
        }
        return err.requestPath?.includes("/members")
          ? `Jira accepted your email and token, but would not show this team's members${detail(err)}. Being able to see the team in Jira's Teams tab is normally enough; if you can, send this message along.`
          : `Jira accepted your email and token, but would not list the teams of this organization${detail(err)}. Check the organization ID against your admin.atlassian.com address.`;
      case "not-found":
        return onTeams
          ? "Jira does not know that organization or team. Check the organization ID."
          : `${what} was not found in Jira.`;
      case "rate-limited":
        return "Jira is rate-limiting this account. Try again in a minute.";
      case "network":
        return "Could not reach Jira. Check your connection.";
      case "unavailable":
        return "Jira is returning errors right now. Try again shortly.";
      default:
        return err.message;
    }
  }
  return err instanceof Error ? err.message : `Could not load ${what}.`;
}

function siteOf(settings: JiraSettings): string {
  return settings.baseUrl.trim().replace(/\/+$/, "");
}

export interface TeamsDirectory {
  orgId: string;
  siteId?: string;
  teams: JiraDirectoryTeam[];
}

export type LoadTeamsResult =
  | ({ ok: true } & TeamsDirectory)
  | {
      ok: false;
      message: string;
      needsOrgId: boolean;
      /** The organization id that was tried, so the user can check it. */
      triedOrgId?: string;
    };

/**
 * Find the organization (unless `orgId` is given) and list its teams.
 * `needsOrgId` says the lookup itself failed, so the UI should ask for the id
 * rather than show a dead end.
 */
export async function loadTeamsDirectory(deps: {
  settings: JiraSettings;
  transport: JiraTransport;
  /** Typed or remembered id; blank = look it up. */
  orgId?: string;
}): Promise<LoadTeamsResult> {
  const { settings, transport } = deps;
  if (!isJiraConfigured(settings)) {
    return {
      ok: false,
      needsOrgId: false,
      message: "Connect Jira first — add your site, email and API token.",
    };
  }
  const base = {
    baseUrl: siteOf(settings),
    auth: basicAuth(settings.email, settings.apiToken),
  };

  // The lookup also gives the site id, which brings in site-scoped teams, so
  // it is tried even when the org id is already known.
  let tenant: { orgId: string; cloudId?: string } | null = null;
  let lookupError: unknown;
  try {
    tenant = await fetchJiraTenant(transport, base);
  } catch (err) {
    if (unavailableOf(err)) {
      return { ok: false, needsOrgId: false, message: describe(err, "") };
    }
    lookupError = err;
  }
  const orgId = deps.orgId?.trim() || tenant?.orgId;
  if (!orgId) {
    return {
      ok: false,
      needsOrgId: true,
      message:
        lookupError instanceof JiraError && lookupError.status === 401
          ? describe(lookupError, "")
          : "Planner could not find your Atlassian organization by itself. Paste its ID below.",
    };
  }
  const siteId = tenant && tenant.orgId === orgId ? tenant.cloudId : undefined;
  try {
    const teams = await fetchTeamDirectory(transport, {
      ...base,
      orgId,
      siteId,
    });
    return { ok: true, orgId, siteId, teams };
  } catch (err) {
    const found = deps.orgId?.trim() ? "" : " (found automatically)";
    return {
      ok: false,
      needsOrgId: err instanceof JiraError && err.kind !== "network",
      triedOrgId: orgId,
      message:
        err instanceof JiraError && err.kind === "bad-response"
          ? `Jira refused to list the teams of organization ${orgId}${found}: ${err.message}. Check it against the ID in your admin.atlassian.com address.`
          : describe(err, "the Teams directory"),
    };
  }
}

/** Where a team's people came from. */
export type PeopleSource =
  /** The team's roster in Jira's Teams tab. */
  | { kind: "roster" }
  /**
   * Jira would not share the roster, so these are the people assigned to the
   * team's Jira issues — a suggestion, not the roster. `refusal` says why the
   * roster was not available, so the dialog can tell the user.
   */
  | { kind: "issues"; refusal: string; sinceDays: number };

export type LoadMembersResult =
  | { ok: true; people: JiraDirectoryPerson[]; source: PeopleSource }
  | { ok: false; message: string };

/**
 * A refusal worth falling back from: Jira answered, and said no (or could not
 * make sense of the request). Not a wrong token, not an unreachable Jira —
 * those would fail the fallback too, and hide the real problem behind it.
 */
function isRosterRefusal(err: unknown): err is JiraError {
  if (unavailableOf(err) || !(err instanceof JiraError)) return false;
  if (err.kind === "auth") return err.status !== 401;
  return err.kind === "not-found" || err.kind === "bad-response";
}

/**
 * A team's people: its roster from the Teams tab when Jira will share it,
 * otherwise the people assigned to the team's Jira issues.
 */
export async function loadTeamPeople(deps: {
  settings: JiraSettings;
  transport: JiraTransport;
  directory: TeamsDirectory;
  teamId: string;
}): Promise<LoadMembersResult> {
  const { settings, transport, directory } = deps;
  const base = {
    baseUrl: siteOf(settings),
    auth: basicAuth(settings.email, settings.apiToken),
  };
  let refusal: JiraError;
  try {
    const people = await fetchTeamMembers(transport, {
      ...base,
      orgId: directory.orgId,
      siteId: directory.siteId,
      teamId: deps.teamId,
      // Lets a group-synced team be read as its Jira group when the Teams
      // API is closed to this account.
      groupId: directory.teams.find((t) => t.id === deps.teamId)?.groupId,
    });
    return { ok: true, people, source: { kind: "roster" } };
  } catch (err) {
    if (!isRosterRefusal(err)) {
      return { ok: false, message: describe(err, "the team's members") };
    }
    refusal = err;
  }
  // Only Atlassian's reason: the advice in the full message ("send this
  // along") does not apply once there is a way forward.
  const reason = detail(refusal).replace(/^ — /, "");
  const why = `Jira wouldn't share this team's roster${reason ? ` (${reason})` : ""}.`;
  try {
    const people = await fetchTeamIssuePeople(transport, {
      ...base,
      teamId: deps.teamId,
      sinceDays: TEAM_ISSUE_WINDOW_DAYS,
    });
    return {
      ok: true,
      people,
      source: {
        kind: "issues",
        refusal: why,
        sinceDays: TEAM_ISSUE_WINDOW_DAYS,
      },
    };
  } catch (err) {
    return {
      ok: false,
      message: `${describe(refusal, "the team's members")} Planner also tried the team's Jira issues: ${describe(err, "the issue search")}`,
    };
  }
}

/* ------------------------------ the preview ------------------------------ */

export interface PersonRow {
  person: JiraDirectoryPerson;
  /** The Planner team this person is already on, if any. Not offered then. */
  alreadyIn?: Team;
  selected: boolean;
  specialization: string;
}

export interface TeamRow {
  team: JiraDirectoryTeam;
  /** A Planner team imported from this Jira team before. Updated, not
   *  duplicated. */
  existing?: Team;
  people: PersonRow[];
  /** Where `people` came from: the roster, or the team's Jira issues. */
  source: PeopleSource;
}

function norm(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function sameSite(a: string, b: string): boolean {
  const clean = (s: string) => s.trim().replace(/\/+$/, "").toLowerCase();
  return clean(a) === clean(b);
}

/** The Planner team already imported from this Jira team, if any. */
export function importedTeamFor(
  team: JiraDirectoryTeam,
  teams: Team[],
  baseUrl: string,
): Team | undefined {
  const fromSite = teams.filter(
    (t) => t.jira && sameSite(t.jira.baseUrl, baseUrl),
  );
  return (
    fromSite.find((t) => t.jira?.teamId === team.id) ??
    fromSite.find(
      (t) => !t.jira?.teamId && norm(t.jira!.teamName) === norm(team.name),
    )
  );
}

/** One team's rows, once its members have been loaded. */
export function previewTeam(
  team: JiraDirectoryTeam,
  people: JiraDirectoryPerson[],
  state: AppState,
  baseUrl: string,
  source: PeopleSource = { kind: "roster" },
): TeamRow {
  const byAccount = new Map<string, Team>();
  const byName = new Map<string, { team: Team; spec: string }>();
  for (const t of state.teams) {
    for (const m of t.members) {
      if (m.jiraAccountId) byAccount.set(m.jiraAccountId, t);
      if (!byName.has(norm(m.name))) {
        byName.set(norm(m.name), { team: t, spec: m.specialization });
      }
    }
  }
  return {
    team,
    source,
    existing: importedTeamFor(team, state.teams, baseUrl),
    people: people.map((person) => {
      const named = byName.get(norm(person.displayName));
      const alreadyIn = byAccount.get(person.accountId) ?? named?.team;
      return {
        person,
        alreadyIn,
        selected: !alreadyIn,
        specialization: named?.spec ?? "",
      };
    }),
  };
}

/** Every specialization in use, for the specialization suggestions. */
export function knownSpecs(state: AppState): string[] {
  const out = new Map<string, string>();
  for (const m of allMembers(state.teams)) {
    const t = m.specialization.trim();
    if (t && !out.has(norm(t))) out.set(norm(t), t);
  }
  return [...out.values()];
}

/** What one ticked team turns into, ready for `actions.importJiraTeam`. */
export function importInput(
  row: TeamRow,
  name: string,
  baseUrl: string,
  orgId: string,
  now: string,
): {
  teamId?: string;
  name: string;
  jira: JiraTeamSource;
  members: { name: string; specialization: string; jiraAccountId: string }[];
} {
  return {
    teamId: row.existing?.id,
    name: name.trim() || row.team.name,
    jira: {
      baseUrl: baseUrl.trim().replace(/\/+$/, ""),
      orgId,
      teamId: row.team.id,
      teamName: row.team.name,
      syncedAt: now,
    },
    members: row.people
      .filter((p) => p.selected && !p.alreadyIn)
      .map((p) => ({
        name: p.person.displayName,
        specialization: p.specialization.trim(),
        jiraAccountId: p.person.accountId,
      })),
  };
}
