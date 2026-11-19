import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  AppState,
  Epic,
  EpicTracking,
  ID,
  JiraSnapshot,
  JiraTeamSource,
  Plan,
  PlanViewMode,
  Project,
  SprintDraft,
  TaskItem,
  Team,
  TeamInclusion,
  Tracker,
  TrackerDeadlines,
  TrackerSample,
} from "@planner/core";
import {
  newId,
  type Action,
  type Direction,
  type HelperInput,
  type HelperPatch,
  type PlanMarkerInput,
  type PlanMarkerPatch,
  type JiraMemberInput,
  type MemberPatch,
  type SprintItemApplied,
  type TaskInput,
  type TaskPatch,
  type TeamInclusionPatch,
} from "./actions";
import { seedState } from "@planner/core";
import { PlannerRuntime } from "./runtime";
import { createInMemoryLocalStore } from "./memoryLocalStore";
import type { SyncStatus } from "./syncClient";

/* ------------------------------- reducer -------------------------------- */

/** Immutably replace the project with the given id. */
function updateProject(
  state: AppState,
  projectId: ID,
  fn: (p: Project) => Project,
): AppState {
  return {
    ...state,
    projects: state.projects.map((p) => (p.id === projectId ? fn(p) : p)),
  };
}

/** Immutably replace the epic with the given id within a project. */
function updateEpic(
  project: Project,
  epicId: ID,
  fn: (e: Epic) => Epic,
): Project {
  return {
    ...project,
    epics: project.epics.map((e) => (e.id === epicId ? fn(e) : e)),
  };
}

/** Immutably replace the team with the given id. */
function updateTeam(
  state: AppState,
  teamId: ID,
  fn: (t: Team) => Team,
): AppState {
  return {
    ...state,
    teams: state.teams.map((t) => (t.id === teamId ? fn(t) : t)),
  };
}

/**
 * Immutably replace the tracker with the given id. An absent `trackers` list
 * means there is nothing to update, so it stays absent rather than becoming an
 * empty array a diff would have to reason about.
 */
function updateTracker(
  state: AppState,
  trackerId: ID,
  fn: (t: Tracker) => Tracker,
): AppState {
  if (!state.trackers) return state;
  return {
    ...state,
    trackers: state.trackers.map((t) => (t.id === trackerId ? fn(t) : t)),
  };
}

/**
 * How many daily readings a tracker keeps. Trend is what samples are for, and
 * ~200 working days of it is most of a year — far more than anyone reads —
 * while keeping the row small enough that syncing a tracker stays cheap.
 */
const MAX_SAMPLES = 200;

/**
 * Fold one reading into a tracker's history.
 *
 * Refreshing three times before lunch must not leave three readings for today:
 * the day is the identity, and the newest reading for a day replaces the
 * earlier one. The list is kept oldest-first so a chart can walk it straight
 * through, and trimmed from the front once it hits the cap.
 */
function mergeSample(
  samples: TrackerSample[],
  sample: TrackerSample,
): TrackerSample[] {
  const next = samples.filter((s) => s.date !== sample.date);
  next.push(sample);
  next.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return next.length > MAX_SAMPLES ? next.slice(-MAX_SAMPLES) : next;
}

/**
 * The project's inclusion list, materialized. When a project has no explicit
 * `teamInclusions` yet, every team participates with no constraints — return
 * that full default so an edit can start from it. `teamId` identifies each
 * entry; the returned entry for `teamId` is guaranteed present.
 */
function materializeInclusions(
  project: Project,
  teams: Team[],
): TeamInclusion[] {
  const base = project.teamInclusions ?? teams.map((t) => ({ teamId: t.id }));
  return base.map((inc) => ({ ...inc }));
}

/** Apply a patch to the inclusion for `teamId`, inserting one if absent. */
function upsertInclusion(
  list: TeamInclusion[],
  teamId: ID,
  patch: TeamInclusionPatch,
): TeamInclusion[] {
  const has = list.some((inc) => inc.teamId === teamId);
  const next = has
    ? list.map((inc) => (inc.teamId === teamId ? { ...inc, ...patch } : inc))
    : [...list, { teamId, ...patch }];
  return next;
}

/** The team a member id belongs to, or undefined. */
function findTeamOf(teams: Team[], memberId: ID): Team | undefined {
  return teams.find((t) => t.members.some((m) => m.id === memberId));
}

/** Drop a team's inclusion from a project (leaving the rest explicit). */
function scrubTeam(project: Project, teamId: ID): Project {
  if (!project.teamInclusions) return project;
  return {
    ...project,
    teamInclusions: project.teamInclusions.filter(
      (inc) => inc.teamId !== teamId,
    ),
  };
}

/** Remove the given member ids from a project's epicAssignments + memberStarts. */
function scrubMembers(project: Project, memberIds: Set<ID>): Project {
  let changed = false;
  const epicAssignments: { [epicId: string]: ID[] } = {};
  for (const [epicId, ids] of Object.entries(project.epicAssignments ?? {})) {
    const kept = ids.filter((id) => !memberIds.has(id));
    if (kept.length !== ids.length) changed = true;
    if (kept.length > 0) epicAssignments[epicId] = kept;
  }
  const memberStarts = { ...(project.memberStarts ?? {}) };
  for (const id of Object.keys(memberStarts)) {
    if (memberIds.has(id)) {
      delete memberStarts[id];
      changed = true;
    }
  }
  if (!changed) return project;
  return { ...project, epicAssignments, memberStarts };
}

/** Move the item with matching id one slot in `direction`, clamped. */
function reorder<T extends { id: ID }>(
  items: T[],
  id: ID,
  direction: Direction,
): T[] {
  const index = items.findIndex((it) => it.id === id);
  if (index === -1) return items;
  const target = index + direction;
  if (target < 0 || target >= items.length) return items;
  const next = items.slice();
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/** Move the item with `id` to an absolute position, shifting the rest. */
function moveWithin<T extends { id: ID }>(
  items: T[],
  id: ID,
  toIndex: number,
): T[] {
  const from = items.findIndex((it) => it.id === id);
  if (from === -1) return items;
  const clamped = Math.max(0, Math.min(toIndex, items.length - 1));
  if (from === clamped) return items;
  const next = items.slice();
  const [moved] = next.splice(from, 1);
  next.splice(clamped, 0, moved);
  return next;
}

/** Deep-clone a project with fresh ids throughout, fully independent. */
function cloneProject(source: Project, newProjectId: ID): Project {
  // Epics and tasks get fresh ids, so anything that references those ids
  // (assignments, dependencies) must be remapped old id -> new id to stay
  // attached. Build the id maps first, then rewrite the references.
  const epicIdMap: { [oldId: string]: ID } = {};
  const taskIdMap: { [oldId: string]: ID } = {};
  const epics = source.epics.map((epic) => {
    const id = newId();
    epicIdMap[epic.id] = id;
    const tasks = epic.tasks.map((task) => {
      const taskId = newId();
      taskIdMap[task.id] = taskId;
      return { ...task, id: taskId };
    });
    return { id, name: epic.name, tasks, dependsOn: epic.dependsOn };
  });
  // Second pass: remap dependency id lists now that every id is known.
  for (const epic of epics) {
    if (epic.dependsOn) {
      epic.dependsOn = epic.dependsOn
        .map((id) => epicIdMap[id])
        .filter((id): id is ID => Boolean(id));
    }
    for (const task of epic.tasks) {
      if (task.dependsOn) {
        task.dependsOn = task.dependsOn
          .map((id) => taskIdMap[id])
          .filter((id): id is ID => Boolean(id));
      }
    }
  }

  const epicAssignments: { [epicId: string]: ID[] } = {};
  for (const [oldEpicId, memberIds] of Object.entries(
    source.epicAssignments ?? {},
  )) {
    const newEpicId = epicIdMap[oldEpicId];
    if (newEpicId) epicAssignments[newEpicId] = [...memberIds];
  }

  // Inclusions key off team ids (unchanged by a copy) but their epic-scope
  // lists reference epic ids, which were just remapped — rewrite those.
  const teamInclusions = source.teamInclusions?.map((inc) => ({
    ...inc,
    epicIds: inc.epicIds
      ?.map((id) => epicIdMap[id])
      .filter((id): id is ID => Boolean(id)),
  }));

  return {
    id: newProjectId,
    name: source.name + " (Copy)",
    startDate: source.startDate,
    note: source.note,
    titleColor: source.titleColor,
    planViewMode: source.planViewMode,
    planMode: source.planMode,
    planLookahead: source.planLookahead,
    buffer: source.buffer,
    // A copy is a fresh scenario to (re)plan; stale plan ids would dangle.
    plan: null,
    epics,
    helpers: (source.helpers ?? []).map((h) => ({ ...h, id: newId() })),
    // Overrides key off global member ids, which are unchanged by a copy.
    memberStarts: { ...(source.memberStarts ?? {}) },
    // Assignments key off member ids (unchanged) but epic ids (remapped above).
    epicAssignments,
    teamInclusions,
    markers: source.markers?.map((m) => ({ ...m, id: newId() })),
    hideMarkers: source.hideMarkers,
  };
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "hydrate":
    case "resetSample":
    case "importState":
      return action.state;

    case "createProject":
      return {
        ...state,
        projects: [
          ...state.projects,
          {
            id: action.id,
            name: action.name,
            startDate: action.startDate,
            epics: [],
            plan: null,
            planViewMode: "person",
            helpers: [],
            memberStarts: {},
            epicAssignments: {},
            // Start with no teams selected; the user opts teams into the
            // project. (An empty list means "none" — an absent list, kept for
            // legacy projects, still means "every team".)
            teamInclusions: [],
          },
        ],
      };

    case "copyProject": {
      const source = state.projects.find((p) => p.id === action.sourceId);
      if (!source) return state;
      const copy = cloneProject(source, action.newId);
      const index = state.projects.findIndex((p) => p.id === action.sourceId);
      const projects = state.projects.slice();
      projects.splice(index + 1, 0, copy);
      return { ...state, projects };
    }

    case "addProject":
      if (state.projects.some((p) => p.id === action.project.id)) return state;
      return { ...state, projects: [...state.projects, action.project] };

    case "deleteProject": {
      const projects = state.projects.filter((p) => p.id !== action.id);
      if (!state.trackers) return { ...state, projects };
      // A tracker outlives its baseline: it keeps refreshing and showing raw
      // Jira numbers, it just has nothing to compare them against any more.
      // Dropping the tracker instead would throw away its sample history.
      const trackers = state.trackers.map((t) => {
        if (t.projectId !== action.id) return t;
        const next = { ...t };
        delete next.projectId;
        return next;
      });
      return { ...state, projects, trackers };
    }

    case "renameProject":
      return updateProject(state, action.id, (p) => ({
        ...p,
        name: action.name,
      }));

    case "setProjectStartDate":
      return updateProject(state, action.id, (p) => ({
        ...p,
        startDate: action.startDate,
      }));

    case "setProjectNote":
      return updateProject(state, action.id, (p) => ({
        ...p,
        note: action.note,
      }));

    case "setProjectTitleColor":
      return updateProject(state, action.id, (p) => {
        const next = { ...p };
        if (action.color) next.titleColor = action.color;
        else delete next.titleColor;
        return next;
      });

    case "setProjectBuffer":
      return updateProject(state, action.id, (p) => {
        // Clamp to 0–100; store 0 as "no buffer" (drop the field entirely).
        const buffer = Math.max(0, Math.min(100, Math.round(action.buffer)));
        const next = { ...p };
        if (buffer > 0) next.buffer = buffer;
        else delete next.buffer;
        return next;
      });

    case "addEpic":
      return updateProject(state, action.projectId, (p) => ({
        ...p,
        epics: [
          ...p.epics,
          { id: action.epicId, name: action.name, tasks: [] },
        ],
      }));

    case "renameEpic":
      return updateProject(state, action.projectId, (p) =>
        updateEpic(p, action.epicId, (e) => ({ ...e, name: action.name })),
      );

    case "deleteEpic":
      return updateProject(state, action.projectId, (p) => {
        // Drop the deleted epic's assignment record so it can't dangle.
        const epicAssignments = { ...(p.epicAssignments ?? {}) };
        delete epicAssignments[action.epicId];
        // Scrub the epic from any team inclusion's epic-scope list too.
        const teamInclusions = p.teamInclusions?.map((inc) =>
          inc.epicIds?.includes(action.epicId)
            ? {
                ...inc,
                epicIds: inc.epicIds.filter((id) => id !== action.epicId),
              }
            : inc,
        );
        // Task ids that will disappear with the epic — scrub them from any
        // other task's dependency list too.
        const goneEpic = p.epics.find((e) => e.id === action.epicId);
        const goneTaskIds = new Set((goneEpic?.tasks ?? []).map((t) => t.id));
        const epics = p.epics
          .filter((e) => e.id !== action.epicId)
          .map((e) => ({
            ...e,
            // Other epics can no longer depend on the removed epic.
            dependsOn: e.dependsOn?.filter((id) => id !== action.epicId),
            tasks: e.tasks.map((t) =>
              t.dependsOn
                ? {
                    ...t,
                    dependsOn: t.dependsOn.filter((id) => !goneTaskIds.has(id)),
                  }
                : t,
            ),
          }));
        return { ...p, epics, epicAssignments, teamInclusions };
      });

    case "reorderEpic":
      return updateProject(state, action.projectId, (p) => ({
        ...p,
        epics: reorder(p.epics, action.epicId, action.direction),
      }));

    case "toggleEpicAssignment":
      return updateProject(state, action.projectId, (p) => {
        const current = p.epicAssignments?.[action.epicId] ?? [];
        const has = current.includes(action.memberId);
        const nextList = has
          ? current.filter((id) => id !== action.memberId)
          : [...current, action.memberId];
        const epicAssignments = { ...(p.epicAssignments ?? {}) };
        if (nextList.length > 0) epicAssignments[action.epicId] = nextList;
        else delete epicAssignments[action.epicId];
        return { ...p, epicAssignments };
      });

    case "toggleEpicDependency":
      // An epic can't depend on itself.
      if (action.epicId === action.dependsOnEpicId) return state;
      return updateProject(state, action.projectId, (p) =>
        updateEpic(p, action.epicId, (e) => {
          const current = e.dependsOn ?? [];
          const has = current.includes(action.dependsOnEpicId);
          const next = has
            ? current.filter((id) => id !== action.dependsOnEpicId)
            : [...current, action.dependsOnEpicId];
          return { ...e, dependsOn: next };
        }),
      );

    case "toggleTaskDependency":
      // A task can't depend on itself.
      if (action.taskId === action.dependsOnTaskId) return state;
      return updateProject(state, action.projectId, (p) =>
        updateEpic(p, action.epicId, (e) => ({
          ...e,
          tasks: e.tasks.map((t) => {
            if (t.id !== action.taskId) return t;
            const current = t.dependsOn ?? [];
            const has = current.includes(action.dependsOnTaskId);
            const next = has
              ? current.filter((id) => id !== action.dependsOnTaskId)
              : [...current, action.dependsOnTaskId];
            return { ...t, dependsOn: next };
          }),
        })),
      );

    case "setTaskDependencies": {
      // Dedupe, and a task still can't depend on itself.
      const next = [...new Set(action.dependsOnTaskIds)].filter(
        (id) => id !== action.taskId,
      );
      return updateProject(state, action.projectId, (p) =>
        updateEpic(p, action.epicId, (e) => ({
          ...e,
          tasks: e.tasks.map((t) =>
            t.id === action.taskId ? { ...t, dependsOn: next } : t,
          ),
        })),
      );
    }

    case "addTask":
      return updateProject(state, action.projectId, (p) =>
        updateEpic(p, action.epicId, (e) => ({
          ...e,
          tasks: [...e.tasks, { id: action.taskId, ...action.task }],
        })),
      );

    case "editTask":
      return updateProject(state, action.projectId, (p) =>
        updateEpic(p, action.epicId, (e) => ({
          ...e,
          tasks: e.tasks.map((t) =>
            t.id === action.taskId ? { ...t, ...action.patch } : t,
          ),
        })),
      );

    case "toggleTaskExcluded":
      return updateProject(state, action.projectId, (p) =>
        updateEpic(p, action.epicId, (e) => ({
          ...e,
          tasks: e.tasks.map((t) =>
            t.id === action.taskId ? { ...t, excluded: !t.excluded } : t,
          ),
        })),
      );

    case "deleteTask":
      return updateProject(state, action.projectId, (p) => ({
        ...p,
        // Remove the task, and scrub it from any other task's dependency list.
        epics: p.epics.map((e) => ({
          ...e,
          tasks: e.tasks
            .filter((t) => t.id !== action.taskId)
            .map((t) =>
              t.dependsOn?.includes(action.taskId)
                ? {
                    ...t,
                    dependsOn: t.dependsOn.filter((id) => id !== action.taskId),
                  }
                : t,
            ),
        })),
      }));

    case "reorderTask":
      return updateProject(state, action.projectId, (p) =>
        updateEpic(p, action.epicId, (e) => ({
          ...e,
          tasks: reorder(e.tasks, action.taskId, action.direction),
        })),
      );

    case "moveTask":
      return updateProject(state, action.projectId, (p) =>
        updateEpic(p, action.epicId, (e) => ({
          ...e,
          tasks: moveWithin(e.tasks, action.taskId, action.toIndex),
        })),
      );

    case "addTeam":
      return {
        ...state,
        teams: [
          ...state.teams,
          { id: action.id, name: action.name, members: [], offDays: {} },
        ],
      };

    case "renameTeam":
      return updateTeam(state, action.id, (t) => ({ ...t, name: action.name }));

    case "deleteTeam": {
      const gone = state.teams.find((t) => t.id === action.id);
      if (!gone) return state;
      // Member ids that vanish with the team — scrub them from every project's
      // per-member records, and drop the team's inclusions everywhere.
      const goneMemberIds = new Set(gone.members.map((m) => m.id));
      const projects = state.projects.map((p) =>
        scrubMembers(scrubTeam(p, action.id), goneMemberIds),
      );
      return {
        ...state,
        projects,
        teams: state.teams.filter((t) => t.id !== action.id),
      };
    }

    case "importJiraTeam": {
      // Nobody may end up on two teams: member ids are globally unique and a
      // person imported twice would be scheduled twice.
      const known = new Set<string>();
      for (const t of state.teams) {
        for (const m of t.members) {
          known.add(m.id);
          if (m.jiraAccountId) known.add(`jira:${m.jiraAccountId}`);
        }
      }
      const incoming = action.members
        .filter(
          (m) => !known.has(m.id) && !known.has(`jira:${m.jiraAccountId}`),
        )
        .map((m) => ({
          id: m.id,
          name: m.name,
          specialization: m.specialization,
          jiraAccountId: m.jiraAccountId,
        }));
      if (state.teams.some((t) => t.id === action.teamId)) {
        return updateTeam(state, action.teamId, (t) => ({
          ...t,
          jira: action.jira,
          members: [...t.members, ...incoming],
        }));
      }
      return {
        ...state,
        teams: [
          ...state.teams,
          {
            id: action.teamId,
            name: action.name,
            members: incoming,
            offDays: {},
            jira: action.jira,
          },
        ],
      };
    }

    case "addTeamMember":
      return updateTeam(state, action.teamId, (t) => ({
        ...t,
        members: [
          ...t.members,
          {
            id: action.id,
            name: action.name,
            specialization: action.specialization,
          },
        ],
      }));

    case "editTeamMember": {
      const team = findTeamOf(state.teams, action.id);
      if (!team) return state;
      return updateTeam(state, team.id, (t) => ({
        ...t,
        members: t.members.map((m) =>
          m.id === action.id ? { ...m, ...action.patch } : m,
        ),
      }));
    }

    case "deleteTeamMember": {
      const team = findTeamOf(state.teams, action.id);
      if (!team) return state;
      // Drop the member from their team + their off-day record...
      const teams = state.teams.map((t) => {
        if (t.id !== team.id) return t;
        const offDays = { ...t.offDays };
        delete offDays[action.id];
        return {
          ...t,
          members: t.members.filter((m) => m.id !== action.id),
          offDays,
        };
      });
      // ...and any epic assignments referencing them across every project.
      const projects = state.projects.map((p) =>
        scrubMembers(p, new Set([action.id])),
      );
      return { ...state, projects, teams };
    }

    case "toggleOffDay": {
      const team = findTeamOf(state.teams, action.memberId);
      if (!team) return state;
      return updateTeam(state, team.id, (t) => {
        const current = t.offDays[action.memberId] ?? [];
        const has = current.includes(action.dateISO);
        const nextDays = has
          ? current.filter((d) => d !== action.dateISO)
          : [...current, action.dateISO].sort();
        return {
          ...t,
          offDays: { ...t.offDays, [action.memberId]: nextDays },
        };
      });
    }

    case "toggleTeamIncluded":
      return updateProject(state, action.projectId, (p) => {
        const list = materializeInclusions(p, state.teams);
        const has = list.some((inc) => inc.teamId === action.teamId);
        const teamInclusions = has
          ? list.filter((inc) => inc.teamId !== action.teamId)
          : [...list, { teamId: action.teamId }];
        return { ...p, teamInclusions };
      });

    case "updateTeamInclusion":
      return updateProject(state, action.projectId, (p) => ({
        ...p,
        teamInclusions: upsertInclusion(
          materializeInclusions(p, state.teams),
          action.teamId,
          action.patch,
        ),
      }));

    case "toggleTeamInclusionEpic":
      return updateProject(state, action.projectId, (p) => {
        const list = materializeInclusions(p, state.teams);
        const current =
          list.find((inc) => inc.teamId === action.teamId)?.epicIds ?? [];
        const epicIds = current.includes(action.epicId)
          ? current.filter((id) => id !== action.epicId)
          : [...current, action.epicId];
        return {
          ...p,
          teamInclusions: upsertInclusion(list, action.teamId, { epicIds }),
        };
      });

    case "addHelper":
      return updateProject(state, action.projectId, (p) => ({
        ...p,
        helpers: [
          ...(p.helpers ?? []),
          { id: action.helperId, ...action.helper },
        ],
      }));

    case "editHelper":
      return updateProject(state, action.projectId, (p) => ({
        ...p,
        helpers: (p.helpers ?? []).map((h) =>
          h.id === action.helperId ? { ...h, ...action.patch } : h,
        ),
      }));

    case "deleteHelper":
      return updateProject(state, action.projectId, (p) => ({
        ...p,
        helpers: (p.helpers ?? []).filter((h) => h.id !== action.helperId),
      }));

    case "addPlanMarker":
      return updateProject(state, action.projectId, (p) => ({
        ...p,
        markers: [
          ...(p.markers ?? []),
          { id: action.markerId, ...action.marker },
        ],
      }));

    case "editPlanMarker":
      return updateProject(state, action.projectId, (p) => ({
        ...p,
        markers: (p.markers ?? []).map((m) =>
          m.id === action.markerId ? { ...m, ...action.patch } : m,
        ),
      }));

    case "deletePlanMarker":
      return updateProject(state, action.projectId, (p) => {
        const markers = (p.markers ?? []).filter(
          (m) => m.id !== action.markerId,
        );
        const next: Project = { ...p, markers };
        if (markers.length === 0) delete next.markers;
        return next;
      });

    case "setMarkersHidden":
      return updateProject(state, action.projectId, (p) => {
        // Only `true` is stored: absent already means "shown".
        const next = { ...p };
        if (action.hidden) next.hideMarkers = true;
        else delete next.hideMarkers;
        return next;
      });

    case "setMemberStart":
      return updateProject(state, action.projectId, (p) => {
        const next = { ...(p.memberStarts ?? {}) };
        if (action.date) next[action.memberId] = action.date;
        else delete next[action.memberId];
        return { ...p, memberStarts: next };
      });

    case "setPlan":
      return updateProject(state, action.projectId, (p) => ({
        ...p,
        plan: action.plan,
      }));

    case "setPlanViewMode":
      return updateProject(state, action.projectId, (p) => ({
        ...p,
        planViewMode: action.mode,
      }));

    case "setPlanMode":
      return updateProject(state, action.projectId, (p) => ({
        ...p,
        planMode: action.mode,
        // Only overwrite the window when a value is supplied, so toggling the
        // mode doesn't reset a lookahead the user tuned.
        planLookahead:
          action.lookahead !== undefined ? action.lookahead : p.planLookahead,
      }));

    case "createTracker":
      return {
        ...state,
        trackers: [
          ...(state.trackers ?? []),
          {
            id: action.id,
            name: action.name,
            initiativeUrl: action.initiativeUrl,
            initiativeKey: action.initiativeKey,
            baseUrl: action.baseUrl,
          },
        ],
      };

    case "addTracker":
      if ((state.trackers ?? []).some((t) => t.id === action.tracker.id)) {
        return state;
      }
      return {
        ...state,
        trackers: [...(state.trackers ?? []), action.tracker],
      };

    case "deleteTracker":
      if (!state.trackers) return state;
      return {
        ...state,
        trackers: state.trackers.filter((t) => t.id !== action.id),
      };

    case "renameTracker":
      return updateTracker(state, action.id, (t) => ({
        ...t,
        name: action.name,
      }));

    case "setTrackerProject":
      return updateTracker(state, action.id, (t) => {
        // "No baseline" is an absent field, not a stored null — see the
        // absent-field-is-the-default rule in CLAUDE.md.
        const next = { ...t };
        if (action.projectId) next.projectId = action.projectId;
        else delete next.projectId;
        return next;
      });

    case "setTrackerHoursPerDay":
      return updateTracker(state, action.id, (t) => {
        const next = { ...t };
        if (action.hoursPerDay !== null) next.hoursPerDay = action.hoursPerDay;
        else delete next.hoursPerDay;
        return next;
      });

    case "setTrackerDeadlines":
      return updateTracker(state, action.id, (t) => {
        const next = { ...t };
        // Only the fields actually set are kept, so "all defaults" is an
        // absent field rather than an empty object (CLAUDE.md: absent field =
        // backward-compatible default).
        const d = action.deadlines ?? {};
        const kept: TrackerDeadlines = {};
        if (d.startDate) kept.startDate = d.startDate;
        if (d.endDate) kept.endDate = d.endDate;
        if (d.devEndDate) kept.devEndDate = d.devEndDate;
        if (d.endPhase && d.endPhase.length > 0)
          kept.endPhase = [...d.endPhase];
        if (Object.keys(kept).length > 0) next.deadlines = kept;
        else delete next.deadlines;
        return next;
      });

    case "setTrackerEpicMap":
      return updateTracker(state, action.id, (t) => ({
        ...t,
        // Copied, because the caller built this map from a UI draft it may
        // keep editing.
        epicMap: { ...action.epicMap },
      }));

    case "setTrackerTaskMap":
      return updateTracker(state, action.id, (t) => ({
        ...t,
        taskMap: { ...action.taskMap },
      }));

    case "setTrackerUntrackedEpics":
      return updateTracker(state, action.id, (t) => {
        const next = { ...t };
        // Absent when empty, and each key once, in the order they were added.
        const keys = [...new Set(action.epicKeys.filter((k) => k !== ""))];
        if (keys.length > 0) next.untrackedEpics = keys;
        else delete next.untrackedEpics;
        return next;
      });

    case "setTrackerEpicTracking":
      return updateTracker(state, action.id, (t) => {
        const next = { ...t };
        // An epic is in one list at most; each list absent when empty.
        const set = (
          field: "untrackedEpics" | "niceToHaveEpics",
          member: boolean,
        ) => {
          const keys = (t[field] ?? []).filter((k) => k !== action.epicKey);
          if (member && action.epicKey !== "") keys.push(action.epicKey);
          if (keys.length > 0) next[field] = keys;
          else delete next[field];
        };
        set("untrackedEpics", action.tracking === "untracked");
        set("niceToHaveEpics", action.tracking === "niceToHave");
        return next;
      });

    case "setTrackerViewTeams":
      return updateTracker(state, action.id, (t) => {
        const next = { ...t };
        // Absent when empty: no selection and every team read the same way.
        const ids = [
          ...new Set(action.teamNames.map((k) => k.trim()).filter((k) => k)),
        ];
        if (ids.length > 0) next.viewTeams = ids;
        else delete next.viewTeams;
        return next;
      });

    case "setTrackerTaskTeam":
      return updateTracker(state, action.id, (t) => {
        const next = { ...t };
        const teams = { ...(t.taskTeams ?? {}) };
        // null goes back to the team worked out from Jira.
        if (action.team?.trim()) teams[action.issueKey] = action.team.trim();
        else delete teams[action.issueKey];
        if (Object.keys(teams).length > 0) next.taskTeams = teams;
        else delete next.taskTeams;
        return next;
      });

    case "setTrackerAddedScope":
      return updateTracker(state, action.id, (t) => {
        const next = { ...t };
        // Absent when empty, so a tracker that never used it and one that
        // cleared it are the same value.
        const kept = Object.fromEntries(
          Object.entries(action.addedScope).filter(([, s]) => s.trim() !== ""),
        );
        if (Object.keys(kept).length > 0) next.addedScope = kept;
        else delete next.addedScope;
        return next;
      });

    case "setTrackerSnapshot":
      return updateTracker(state, action.id, (t) => {
        const next: Tracker = { ...t, snapshot: action.snapshot };
        // No sample when there is no baseline to measure against; the
        // snapshot is still worth keeping.
        if (action.sample) {
          next.samples = mergeSample(t.samples ?? [], action.sample);
        }
        return next;
      });

    case "setTrackerSprintDraft":
      return updateTracker(state, action.id, (t) => {
        const next = { ...t };
        if (action.draft) next.sprintDraft = action.draft;
        else delete next.sprintDraft;
        return next;
      });

    case "markSprintItemsApplied":
      return updateTracker(state, action.id, (t) => {
        const draft = t.sprintDraft;
        if (!draft) return t;
        // A write-back can partially succeed, and the draft can have moved on
        // since it started, so only the rows Jira confirmed are stamped and
        // keys that no longer exist are dropped on the floor.
        const byKey = new Map(action.applied.map((a) => [a.issueKey, a]));
        return {
          ...t,
          sprintDraft: {
            ...draft,
            items: draft.items.map((item) => {
              const hit = byKey.get(item.issueKey);
              if (!hit) return item;
              return {
                ...item,
                applied: {
                  at: hit.at,
                  startDate: hit.startDate,
                  dueDate: hit.dueDate,
                },
              };
            }),
          },
        };
      });

    default: {
      // Exhaustiveness guard: a new action type will surface here at compile time.
      const _never: never = action;
      return _never;
    }
  }
}

/* ---------------------------- store context ----------------------------- */

export interface StoreValue {
  state: AppState;
  /** Where this device stands with the sync server. "offline" also covers a
   *  runtime built with no sync at all — check `syncEnabled` to tell them
   *  apart before showing the user a connection warning. */
  syncStatus: SyncStatus;
  syncEnabled: boolean;
  /** False until the local database has been read. Nothing meaningful can be
   *  rendered before then, since we would be showing an empty app. */
  ready: boolean;
  /**
   * Apply one typed action as it is, ids and all. For a host that plans its
   * edits as actions elsewhere (the MCP bridge, whose tools return the
   * actions a click would dispatch). Components use `actions` instead.
   */
  dispatch: (action: Action) => void;
  actions: {
    resetSample: () => void;
    importState: (state: AppState) => void;
    createProject: (name: string, startDate: string) => ID;
    copyProject: (sourceId: ID) => ID;
    addProject: (project: Project) => void;
    deleteProject: (id: ID) => void;
    renameProject: (id: ID, name: string) => void;
    setProjectStartDate: (id: ID, startDate: string) => void;
    setProjectNote: (id: ID, note: string) => void;
    setProjectTitleColor: (id: ID, color: string | null) => void;
    setProjectBuffer: (id: ID, buffer: number) => void;
    addEpic: (projectId: ID, name: string) => ID;
    renameEpic: (projectId: ID, epicId: ID, name: string) => void;
    deleteEpic: (projectId: ID, epicId: ID) => void;
    reorderEpic: (projectId: ID, epicId: ID, direction: Direction) => void;
    toggleEpicAssignment: (projectId: ID, epicId: ID, memberId: ID) => void;
    toggleEpicDependency: (
      projectId: ID,
      epicId: ID,
      dependsOnEpicId: ID,
    ) => void;
    addTask: (projectId: ID, epicId: ID, task: TaskInput) => ID;
    editTask: (projectId: ID, epicId: ID, taskId: ID, patch: TaskPatch) => void;
    toggleTaskExcluded: (projectId: ID, epicId: ID, taskId: ID) => void;
    deleteTask: (projectId: ID, epicId: ID, taskId: ID) => void;
    reorderTask: (
      projectId: ID,
      epicId: ID,
      taskId: ID,
      direction: Direction,
    ) => void;
    moveTask: (projectId: ID, epicId: ID, taskId: ID, toIndex: number) => void;
    toggleTaskDependency: (
      projectId: ID,
      epicId: ID,
      taskId: ID,
      dependsOnTaskId: ID,
    ) => void;
    setTaskDependencies: (
      projectId: ID,
      epicId: ID,
      taskId: ID,
      dependsOnTaskIds: ID[],
    ) => void;
    addTeam: (name: string) => ID;
    renameTeam: (id: ID, name: string) => void;
    deleteTeam: (id: ID) => void;
    addTeamMember: (teamId: ID, name: string, specialization: string) => ID;
    /** Create a team from Jira (no `teamId`) or add people to one already
     *  imported. Returns the team's id. */
    importJiraTeam: (input: {
      teamId?: ID;
      name: string;
      jira: JiraTeamSource;
      members: JiraMemberInput[];
    }) => ID;
    editTeamMember: (id: ID, patch: MemberPatch) => void;
    deleteTeamMember: (id: ID) => void;
    toggleOffDay: (memberId: ID, dateISO: string) => void;
    toggleTeamIncluded: (projectId: ID, teamId: ID) => void;
    updateTeamInclusion: (
      projectId: ID,
      teamId: ID,
      patch: TeamInclusionPatch,
    ) => void;
    toggleTeamInclusionEpic: (projectId: ID, teamId: ID, epicId: ID) => void;
    addHelper: (projectId: ID, helper: HelperInput) => ID;
    editHelper: (projectId: ID, helperId: ID, patch: HelperPatch) => void;
    addPlanMarker: (projectId: ID, marker: PlanMarkerInput) => ID;
    editPlanMarker: (
      projectId: ID,
      markerId: ID,
      patch: PlanMarkerPatch,
    ) => void;
    deletePlanMarker: (projectId: ID, markerId: ID) => void;
    setMarkersHidden: (projectId: ID, hidden: boolean) => void;
    deleteHelper: (projectId: ID, helperId: ID) => void;
    setMemberStart: (projectId: ID, memberId: ID, date: string | null) => void;
    setPlan: (projectId: ID, plan: Plan | null) => void;
    setPlanViewMode: (projectId: ID, mode: PlanViewMode) => void;
    setPlanMode: (
      projectId: ID,
      mode: "balanced" | "smart",
      lookahead?: number,
    ) => void;
    createTracker: (
      name: string,
      initiativeUrl: string,
      initiativeKey: string,
      baseUrl: string,
    ) => ID;
    addTracker: (tracker: Tracker) => void;
    deleteTracker: (id: ID) => void;
    renameTracker: (id: ID, name: string) => void;
    setTrackerProject: (id: ID, projectId: ID | null) => void;
    setTrackerHoursPerDay: (id: ID, hoursPerDay: number | null) => void;
    setTrackerDeadlines: (id: ID, deadlines: TrackerDeadlines | null) => void;
    setTrackerEpicMap: (
      id: ID,
      epicMap: { [jiraEpicKey: string]: ID | null },
    ) => void;
    setTrackerTaskMap: (
      id: ID,
      taskMap: { [jiraIssueKey: string]: ID | null },
    ) => void;
    setTrackerAddedScope: (
      id: ID,
      addedScope: { [jiraIssueKey: string]: string },
    ) => void;
    setTrackerUntrackedEpics: (id: ID, epicKeys: string[]) => void;
    /** Track an epic, leave it out as another team's, or follow it as
     *  nice-to-have work on top of the plan. */
    setTrackerEpicTracking: (
      id: ID,
      epicKey: string,
      tracking: EpicTracking,
    ) => void;
    setTrackerViewTeams: (id: ID, teamNames: string[]) => void;
    setTrackerTaskTeam: (id: ID, issueKey: string, team: string | null) => void;
    setTrackerSnapshot: (
      id: ID,
      snapshot: JiraSnapshot,
      sample: TrackerSample | null,
    ) => void;
    setTrackerSprintDraft: (id: ID, draft: SprintDraft | null) => void;
    markSprintItemsApplied: (id: ID, applied: SprintItemApplied[]) => void;
  };
}

const StoreContext = createContext<StoreValue | null>(null);

const EMPTY_STATE: AppState = { projects: [], teams: [] };

export function AppStoreProvider({
  children,
  runtime: providedRuntime,
  initial,
}: {
  children: ReactNode;
  /**
   * Owns the local database and, if configured, the sync connection. Omit it
   * for an ephemeral session that keeps everything in memory and syncs nowhere
   * — which is exactly what a component test wants.
   */
  runtime?: PlannerRuntime;
  /** Skip the initial load and start from this state (used by tests). */
  initial?: AppState;
}) {
  const fallback = useRef<PlannerRuntime | null>(null);
  if (!providedRuntime && !fallback.current) {
    fallback.current = new PlannerRuntime({
      store: createInMemoryLocalStore(),
    });
  }
  const runtime = providedRuntime ?? fallback.current!;

  const [state, dispatch] = useReducer(reducer, initial ?? EMPTY_STATE);
  const [ready, setReady] = useState(initial !== undefined);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(runtime.syncStatus);

  /**
   * The last state we persisted. Every commit is a diff against this rather
   * than against the previous render, so a burst of dispatches collapses into
   * one set of row edits and a remote update can't be mistaken for a local one.
   */
  const persisted = useRef<AppState>(initial ?? EMPTY_STATE);

  /** Adopt a state that came from the database — never diffed back down. */
  const adopt = useCallback((next: AppState) => {
    persisted.current = next;
    dispatch({ type: "importState", state: next });
  }, []);

  // Initial load. `initial` short-circuits it so tests stay synchronous.
  useEffect(() => {
    if (initial !== undefined) return;
    let cancelled = false;
    void runtime.load().then((loaded) => {
      if (cancelled) return;
      adopt(loaded);
      setReady(true);
      runtime.start();
    });
    return () => {
      cancelled = true;
    };
  }, [runtime, initial, adopt]);

  // Remote ops landed: re-read and adopt.
  useEffect(() => {
    return runtime.onRemoteChange(() => {
      void runtime.read().then(adopt);
    });
  }, [runtime, adopt]);

  useEffect(() => runtime.onStatusChange(setSyncStatus), [runtime]);

  // Local edits: diff against what we last persisted and commit the delta.
  useEffect(() => {
    if (!ready) return;
    if (state === persisted.current) return;
    const prev = persisted.current;
    persisted.current = state;
    void runtime.commit(prev, state);
  }, [state, ready, runtime]);

  const value = useMemo<StoreValue>(() => {
    return {
      state,
      ready,
      syncStatus,
      syncEnabled: runtime.syncEnabled,
      dispatch,
      actions: {
        // Both of these replace the whole state; the commit effect diffs it
        // against what is stored and emits the creates/updates/tombstones.
        resetSample: () =>
          dispatch({ type: "resetSample", state: seedState() }),
        importState: (next) => dispatch({ type: "importState", state: next }),
        createProject: (name, startDate) => {
          const id = newId();
          dispatch({ type: "createProject", id, name, startDate });
          return id;
        },
        copyProject: (sourceId) => {
          const id = newId();
          dispatch({ type: "copyProject", sourceId, newId: id });
          return id;
        },
        addProject: (project) => dispatch({ type: "addProject", project }),
        deleteProject: (id) => dispatch({ type: "deleteProject", id }),
        renameProject: (id, name) =>
          dispatch({ type: "renameProject", id, name }),
        setProjectStartDate: (id, startDate) =>
          dispatch({ type: "setProjectStartDate", id, startDate }),
        setProjectNote: (id, note) =>
          dispatch({ type: "setProjectNote", id, note }),
        setProjectTitleColor: (id, color) =>
          dispatch({ type: "setProjectTitleColor", id, color }),
        setProjectBuffer: (id, buffer) =>
          dispatch({ type: "setProjectBuffer", id, buffer }),
        addEpic: (projectId, name) => {
          const epicId = newId();
          dispatch({ type: "addEpic", projectId, epicId, name });
          return epicId;
        },
        renameEpic: (projectId, epicId, name) =>
          dispatch({ type: "renameEpic", projectId, epicId, name }),
        deleteEpic: (projectId, epicId) =>
          dispatch({ type: "deleteEpic", projectId, epicId }),
        reorderEpic: (projectId, epicId, direction) =>
          dispatch({ type: "reorderEpic", projectId, epicId, direction }),
        toggleEpicAssignment: (projectId, epicId, memberId) =>
          dispatch({
            type: "toggleEpicAssignment",
            projectId,
            epicId,
            memberId,
          }),
        toggleEpicDependency: (projectId, epicId, dependsOnEpicId) =>
          dispatch({
            type: "toggleEpicDependency",
            projectId,
            epicId,
            dependsOnEpicId,
          }),
        addTask: (projectId, epicId, task) => {
          const taskId = newId();
          dispatch({ type: "addTask", projectId, epicId, taskId, task });
          return taskId;
        },
        editTask: (projectId, epicId, taskId, patch) =>
          dispatch({ type: "editTask", projectId, epicId, taskId, patch }),
        toggleTaskExcluded: (projectId, epicId, taskId) =>
          dispatch({ type: "toggleTaskExcluded", projectId, epicId, taskId }),
        deleteTask: (projectId, epicId, taskId) =>
          dispatch({ type: "deleteTask", projectId, epicId, taskId }),
        reorderTask: (projectId, epicId, taskId, direction) =>
          dispatch({
            type: "reorderTask",
            projectId,
            epicId,
            taskId,
            direction,
          }),
        moveTask: (projectId, epicId, taskId, toIndex) =>
          dispatch({
            type: "moveTask",
            projectId,
            epicId,
            taskId,
            toIndex,
          }),
        toggleTaskDependency: (projectId, epicId, taskId, dependsOnTaskId) =>
          dispatch({
            type: "toggleTaskDependency",
            projectId,
            epicId,
            taskId,
            dependsOnTaskId,
          }),
        setTaskDependencies: (projectId, epicId, taskId, dependsOnTaskIds) =>
          dispatch({
            type: "setTaskDependencies",
            projectId,
            epicId,
            taskId,
            dependsOnTaskIds,
          }),
        addTeam: (name) => {
          const id = newId();
          dispatch({ type: "addTeam", id, name });
          return id;
        },
        renameTeam: (id, name) => dispatch({ type: "renameTeam", id, name }),
        deleteTeam: (id) => dispatch({ type: "deleteTeam", id }),
        importJiraTeam: ({ teamId, name, jira, members }) => {
          const id = teamId ?? newId();
          dispatch({
            type: "importJiraTeam",
            teamId: id,
            name,
            jira,
            members: members.map((m) => ({ ...m, id: newId() })),
          });
          return id;
        },
        addTeamMember: (teamId, name, specialization) => {
          const id = newId();
          dispatch({ type: "addTeamMember", teamId, id, name, specialization });
          return id;
        },
        editTeamMember: (id, patch) =>
          dispatch({ type: "editTeamMember", id, patch }),
        deleteTeamMember: (id) => dispatch({ type: "deleteTeamMember", id }),
        toggleOffDay: (memberId, dateISO) =>
          dispatch({ type: "toggleOffDay", memberId, dateISO }),
        toggleTeamIncluded: (projectId, teamId) =>
          dispatch({ type: "toggleTeamIncluded", projectId, teamId }),
        updateTeamInclusion: (projectId, teamId, patch) =>
          dispatch({ type: "updateTeamInclusion", projectId, teamId, patch }),
        toggleTeamInclusionEpic: (projectId, teamId, epicId) =>
          dispatch({
            type: "toggleTeamInclusionEpic",
            projectId,
            teamId,
            epicId,
          }),
        addHelper: (projectId, helper) => {
          const helperId = newId();
          dispatch({ type: "addHelper", projectId, helperId, helper });
          return helperId;
        },
        editHelper: (projectId, helperId, patch) =>
          dispatch({ type: "editHelper", projectId, helperId, patch }),
        addPlanMarker: (projectId, marker) => {
          const markerId = newId();
          dispatch({ type: "addPlanMarker", projectId, markerId, marker });
          return markerId;
        },
        editPlanMarker: (projectId, markerId, patch) =>
          dispatch({ type: "editPlanMarker", projectId, markerId, patch }),
        deletePlanMarker: (projectId, markerId) =>
          dispatch({ type: "deletePlanMarker", projectId, markerId }),
        setMarkersHidden: (projectId, hidden) =>
          dispatch({ type: "setMarkersHidden", projectId, hidden }),
        deleteHelper: (projectId, helperId) =>
          dispatch({ type: "deleteHelper", projectId, helperId }),
        setMemberStart: (projectId, memberId, date) =>
          dispatch({ type: "setMemberStart", projectId, memberId, date }),
        setPlan: (projectId, plan) =>
          dispatch({ type: "setPlan", projectId, plan }),
        setPlanViewMode: (projectId, mode) =>
          dispatch({ type: "setPlanViewMode", projectId, mode }),
        setPlanMode: (projectId, mode, lookahead) =>
          dispatch({ type: "setPlanMode", projectId, mode, lookahead }),
        createTracker: (name, initiativeUrl, initiativeKey, baseUrl) => {
          const id = newId();
          dispatch({
            type: "createTracker",
            id,
            name,
            initiativeUrl,
            initiativeKey,
            baseUrl,
          });
          return id;
        },
        addTracker: (tracker) => dispatch({ type: "addTracker", tracker }),
        deleteTracker: (id) => dispatch({ type: "deleteTracker", id }),
        renameTracker: (id, name) =>
          dispatch({ type: "renameTracker", id, name }),
        setTrackerProject: (id, projectId) =>
          dispatch({ type: "setTrackerProject", id, projectId }),
        setTrackerHoursPerDay: (id, hoursPerDay) =>
          dispatch({ type: "setTrackerHoursPerDay", id, hoursPerDay }),
        setTrackerDeadlines: (id, deadlines) =>
          dispatch({ type: "setTrackerDeadlines", id, deadlines }),
        setTrackerEpicMap: (id, epicMap) =>
          dispatch({ type: "setTrackerEpicMap", id, epicMap }),
        setTrackerTaskMap: (id, taskMap) =>
          dispatch({ type: "setTrackerTaskMap", id, taskMap }),
        setTrackerAddedScope: (id, addedScope) =>
          dispatch({ type: "setTrackerAddedScope", id, addedScope }),
        setTrackerUntrackedEpics: (id, epicKeys) =>
          dispatch({ type: "setTrackerUntrackedEpics", id, epicKeys }),
        setTrackerEpicTracking: (id, epicKey, tracking) =>
          dispatch({ type: "setTrackerEpicTracking", id, epicKey, tracking }),
        setTrackerViewTeams: (id, teamNames) =>
          dispatch({ type: "setTrackerViewTeams", id, teamNames }),
        setTrackerTaskTeam: (id, issueKey, team) =>
          dispatch({ type: "setTrackerTaskTeam", id, issueKey, team }),
        setTrackerSnapshot: (id, snapshot, sample) =>
          dispatch({ type: "setTrackerSnapshot", id, snapshot, sample }),
        setTrackerSprintDraft: (id, draft) =>
          dispatch({ type: "setTrackerSprintDraft", id, draft }),
        markSprintItemsApplied: (id, applied) =>
          dispatch({ type: "markSprintItemsApplied", id, applied }),
      },
    };
  }, [state, ready, syncStatus, runtime]);

  return (
    <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
  );
}

export function useAppStore(): StoreValue {
  const ctx = useContext(StoreContext);
  if (!ctx) {
    throw new Error("useAppStore must be used within an <AppStoreProvider>");
  }
  return ctx;
}

/** Convenience selector for a single project by id. */
export function useProject(id: ID | undefined): Project | undefined {
  const { state } = useAppStore();
  return state.projects.find((p) => p.id === id);
}

// Re-export so consumers can type task shapes without reaching into actions.
export type { TaskInput, TaskItem };
