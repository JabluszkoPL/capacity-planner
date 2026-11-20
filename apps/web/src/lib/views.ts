import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import type { IconName } from "../components/ui/Icon";

/**
 * The sub-screens of a project and of a tracker.
 *
 * A project or a tracker is too much for one scrolling page, so each is split
 * into views. The view lives in the URL as `?view=`, which keeps the route
 * shapes (`/project/:id`, `/tracking/:id`) every link, test and MCP tool
 * already uses, and makes each view linkable. The page shows these as tabs
 * under its header (ui/ViewTabs) and renders the one that is selected. An absent or unknown view is the
 * first one.
 */
export interface ViewDef<T extends string> {
  id: T;
  label: string;
  icon: IconName;
}

export const PROJECT_VIEWS = [
  { id: "overview", label: "Overview", icon: "home" },
  { id: "tasks", label: "Epics & tasks", icon: "list" },
  { id: "people", label: "Teams & people", icon: "users" },
  { id: "plan", label: "Plan & timeline", icon: "timeline" },
  { id: "settings", label: "Settings", icon: "settings" },
] as const satisfies readonly ViewDef<string>[];

export type ProjectView = (typeof PROJECT_VIEWS)[number]["id"];

export const TRACKER_VIEWS = [
  { id: "overview", label: "Overview", icon: "gauge" },
  { id: "issues", label: "Issues", icon: "list" },
  { id: "forecast", label: "Work left", icon: "timeline" },
  { id: "sprints", label: "Sprints", icon: "sprint" },
  { id: "history", label: "History", icon: "history" },
] as const satisfies readonly ViewDef<string>[];

export type TrackerView = (typeof TRACKER_VIEWS)[number]["id"];

/** The selected view from `?view=`, and a setter that keeps other params. */
export function useView<T extends string>(
  views: readonly ViewDef<T>[],
): [T, (next: T) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get("view");
  const current = views.find((v) => v.id === raw)?.id ?? views[0]!.id;
  const set = useCallback(
    (next: T) => {
      setParams((prev) => {
        const p = new URLSearchParams(prev);
        if (next === views[0]!.id) p.delete("view");
        else p.set("view", next);
        return p;
      });
    },
    [setParams, views],
  );
  return [current, set];
}

/** The link to one view of a page. */
export function viewHref(base: string, view: string, first: string): string {
  return view === first ? base : `${base}?view=${view}`;
}
