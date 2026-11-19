/**
 * What a tool runs against, and what it hands back.
 *
 * Tools are pure: they read an {@link AppState}, and a tool that changes
 * something returns the typed store {@link Action}s that make the change. The
 * host - the open window - dispatches those exactly as a button would, so an
 * edit from an AI client goes through the same reducer, the same diff, the
 * same last-write-wins sync as one made by hand. Nothing here touches the
 * database, the network or the clock: `today`, `now` and fresh ids arrive in
 * the context.
 */
import type { Action } from "@planner/client-runtime/actions";
import type { AppState, ID } from "@planner/core";
import type { TagAlias } from "@planner/jira";

/** Where the open window is, as a router path ("/project/abc"). */
export interface CurrentView {
  path: string;
}

export interface ToolContext {
  state: AppState;
  /** ISO date, for tracker readings. */
  today: string;
  /** ISO datetime, stamped on plans the tool runs. */
  now: string;
  newId: () => ID;
  /** The store's reducer, so a tool can report what its actions led to. */
  reduce: (state: AppState, action: Action) => AppState;
  view: CurrentView;
  /** This device's remembered tag -> specialization mappings, if any. */
  tagAliases?: readonly TagAlias[];
}

export interface ToolOutcome {
  /** What the client is told. Serialised to JSON. */
  result: unknown;
  /** Store actions to dispatch, in order. Empty for reads. */
  actions: Action[];
  /** A path for the window to show afterwards. */
  navigate?: string;
  /** One line the app may show the user about a change it just made. */
  notice?: string;
}

/**
 * A mistake in the request (a name that matches nothing, a date in the wrong
 * place). Its message goes back to the model verbatim, so it says how to fix
 * the call, not just that it failed.
 */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

/** Apply actions with the store's own reducer. */
export function applyActions(ctx: ToolContext, actions: Action[]): AppState {
  return actions.reduce(ctx.reduce, ctx.state);
}
