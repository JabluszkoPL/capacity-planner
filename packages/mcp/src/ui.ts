/**
 * View tools: what the open window is showing, and changing it.
 *
 * Navigation is a path for the window's router (the same routes the app
 * declares in apps/web/src/App.tsx). Two of these also save a setting, because
 * that is where the app keeps it: a tracker's team selection and a plan's
 * view mode are part of the data and sync like it. They change how things are
 * shown, not what is planned, so they sit with the view tools.
 */
import type { Action } from "@planner/client-runtime/actions";
import {
  selectedTeams,
  teamKey,
  trackerTeams,
  type PlanViewMode,
} from "@planner/core";
import { ToolError, type ToolContext, type ToolOutcome } from "./context";
import { findProject, findTracker } from "./resolve";

export type Page = "dashboard" | "team" | "tracking";

const PAGE_PATHS: Record<Page, string> = {
  dashboard: "/",
  team: "/team",
  tracking: "/tracking",
};

export interface ParsedView {
  page: "dashboard" | "project" | "team" | "tracking" | "tracker" | "other";
  projectId?: string;
  trackerId?: string;
}

/** A router path ("/project/abc", "/tracking/xyz") read back as a page. */
export function parseViewPath(path: string): ParsedView {
  const clean = (path.split(/[?#]/)[0] || "/").replace(/\/+$/, "") || "/";
  if (clean === "/") return { page: "dashboard" };
  if (clean === "/team") return { page: "team" };
  if (clean === "/tracking") return { page: "tracking" };
  const project = /^\/project\/([^/]+)$/.exec(clean);
  if (project) {
    return { page: "project", projectId: decodeURIComponent(project[1]) };
  }
  const tracker = /^\/tracking\/([^/]+)$/.exec(clean);
  if (tracker) {
    return { page: "tracker", trackerId: decodeURIComponent(tracker[1]) };
  }
  return { page: "other" };
}

const projectPath = (id: string) => `/project/${encodeURIComponent(id)}`;
const trackerPath = (id: string) => `/tracking/${encodeURIComponent(id)}`;

function read(result: unknown): ToolOutcome {
  return { result, actions: [] };
}

export function getCurrentView(ctx: ToolContext): ToolOutcome {
  const view = parseViewPath(ctx.view.path);
  const project = view.projectId
    ? ctx.state.projects.find((p) => p.id === view.projectId)
    : undefined;
  const tracker = view.trackerId
    ? (ctx.state.trackers ?? []).find((t) => t.id === view.trackerId)
    : undefined;
  return read({
    path: ctx.view.path,
    page: view.page,
    ...(project
      ? {
          project: {
            id: project.id,
            name: project.name,
            planViewMode: project.planViewMode,
          },
        }
      : {}),
    ...(tracker
      ? {
          tracker: {
            id: tracker.id,
            name: tracker.name,
            viewTeams: tracker.viewTeams ?? [],
          },
        }
      : {}),
  });
}

export function openPage(_ctx: ToolContext, args: { page: Page }): ToolOutcome {
  return {
    result: { opened: args.page },
    actions: [],
    navigate: PAGE_PATHS[args.page],
  };
}

export function openProject(
  ctx: ToolContext,
  args: { project: string },
): ToolOutcome {
  const p = findProject(ctx.state, args.project);
  return {
    result: { opened: { project: { id: p.id, name: p.name } } },
    actions: [],
    navigate: projectPath(p.id),
  };
}

export function openTracker(
  ctx: ToolContext,
  args: { tracker: string },
): ToolOutcome {
  const t = findTracker(ctx.state, args.tracker);
  return {
    result: { opened: { tracker: { id: t.id, name: t.name } } },
    actions: [],
    navigate: trackerPath(t.id),
  };
}

/** The tracker named, or the one the window is showing. */
function trackerArg(ctx: ToolContext, ref: string | undefined) {
  if (ref) return findTracker(ctx.state, ref);
  const id = parseViewPath(ctx.view.path).trackerId;
  const shown = id
    ? (ctx.state.trackers ?? []).find((t) => t.id === id)
    : undefined;
  if (!shown) {
    throw new ToolError(
      "No tracker is open in the window. Pass tracker (an id or name).",
    );
  }
  return shown;
}

/** The project named, or the one the window is showing. */
function projectArg(ctx: ToolContext, ref: string | undefined) {
  if (ref) return findProject(ctx.state, ref);
  const id = parseViewPath(ctx.view.path).projectId;
  const shown = id ? ctx.state.projects.find((p) => p.id === id) : undefined;
  if (!shown) {
    throw new ToolError(
      "No project is open in the window. Pass project (an id or name).",
    );
  }
  return shown;
}

export function selectTrackerTeams(
  ctx: ToolContext,
  args: { tracker?: string; teams: string[] },
): ToolOutcome {
  const tracker = trackerArg(ctx, args.tracker);
  const project = tracker.projectId
    ? ctx.state.projects.find((p) => p.id === tracker.projectId)
    : undefined;
  if (!project) {
    throw new ToolError(
      `Tracker "${tracker.name}" has no baseline project, so it has no teams to choose from.`,
    );
  }
  const options = trackerTeams(tracker, project, ctx.state.teams);
  const byKey = new Map(options.map((o) => [teamKey(o.name), o.name]));
  const names: string[] = [];
  for (const wanted of args.teams) {
    const hit = byKey.get(teamKey(wanted));
    if (!hit) {
      throw new ToolError(
        `"${wanted}" is not a team on tracker "${tracker.name}". Teams: ${
          options.map((o) => `"${o.name}"`).join(", ") || "none"
        }.`,
      );
    }
    if (!names.includes(hit)) names.push(hit);
  }
  const actions: Action[] = [
    { type: "setTrackerViewTeams", id: tracker.id, teamNames: names },
  ];
  const next = actions.reduce(ctx.reduce, ctx.state);
  const after = (next.trackers ?? []).find((t) => t.id === tracker.id)!;
  return {
    result: {
      tracker: { id: tracker.id, name: tracker.name },
      reading: selectedTeams(after, project, next.teams) ?? "every team",
      available: options.map((o) => ({ name: o.name, jiraTasks: o.tasks })),
    },
    actions,
    navigate: trackerPath(tracker.id),
    notice: `Showing ${names.length ? names.join(", ") : "every team"} on "${tracker.name}"`,
  };
}

export function setPlanView(
  ctx: ToolContext,
  args: { project?: string; mode: PlanViewMode },
): ToolOutcome {
  const project = projectArg(ctx, args.project);
  const actions: Action[] =
    project.planViewMode === args.mode
      ? []
      : [{ type: "setPlanViewMode", projectId: project.id, mode: args.mode }];
  return {
    result: {
      project: { id: project.id, name: project.name },
      planViewMode: args.mode,
    },
    actions,
    navigate: projectPath(project.id),
  };
}
