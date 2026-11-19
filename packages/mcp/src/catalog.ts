/**
 * The tool catalogue: every tool's name, description, schema and access
 * level, and the function behind it.
 *
 * Definitions are data the Mac app's main process lists without asking the
 * window; {@link runTool} is what the window runs when a call arrives. Both
 * come from this one table, so a tool cannot be listed without an
 * implementation or run without a schema.
 */
import { ToolError, type ToolContext, type ToolOutcome } from "./context";
import {
  checkArgs,
  type JsonSchema,
  type ObjectSchema,
  type ToolAccess,
  type ToolDefinition,
} from "./schema";
import { getProject, listProjects, listTeams, previewPlan } from "./read";
import {
  getTracker,
  getTrackerIssues,
  getTrackerScopeChanges,
  listTrackers,
} from "./tracker";
import {
  addEpic,
  addHelper,
  addTask,
  addTeamMember,
  copyProject,
  createProject,
  runPlanTool,
  setMemberOffDays,
  setMemberStart,
  setTeamInclusion,
  updateProject,
  updateTask,
  updateTeamMember,
} from "./write";
import {
  getCurrentView,
  openPage,
  openProject,
  openTracker,
  selectTrackerTeams,
  setPlanView,
} from "./ui";

/* ------------------------------ schema bits ------------------------------ */

const str = (description: string): JsonSchema => ({
  type: "string",
  description,
  minLength: 1,
});
const date = (description: string): JsonSchema => ({
  type: "string",
  format: "date",
  description: `${description} (YYYY-MM-DD).`,
});
const dateList = (description: string): JsonSchema => ({
  type: "array",
  maxItems: 400,
  description,
  items: {
    type: "string",
    format: "date-or-range",
    description:
      "YYYY-MM-DD, or YYYY-MM-DD..YYYY-MM-DD for every weekday in between.",
  },
});
const ref = (kind: string) => str(`The ${kind}'s id or exact name.`);
const obj = (
  properties: Record<string, JsonSchema>,
  required: string[] = [],
): ObjectSchema => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

/* ------------------------------- the table ------------------------------- */

interface ToolEntry extends ToolDefinition {
  run(ctx: ToolContext, args: never): ToolOutcome;
}

function readTool(
  name: string,
  title: string,
  description: string,
  inputSchema: ObjectSchema,
  run: (ctx: ToolContext, args: never) => unknown,
): ToolEntry {
  return {
    name,
    title,
    description,
    access: "read",
    inputSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (ctx, args) => ({ result: run(ctx, args), actions: [] }),
  };
}

function tool(
  access: Exclude<ToolAccess, "read">,
  name: string,
  title: string,
  description: string,
  inputSchema: ObjectSchema,
  run: (ctx: ToolContext, args: never) => ToolOutcome,
  hints: { idempotent?: boolean } = {},
): ToolEntry {
  return {
    name,
    title,
    description,
    access,
    inputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      ...(hints.idempotent !== undefined
        ? { idempotentHint: hints.idempotent }
        : {}),
      openWorldHint: false,
    },
    run,
  };
}

const ENTRIES: ToolEntry[] = [
  /* --------------------------------- read --------------------------------- */
  readTool(
    "list_projects",
    "List projects",
    "Every project with its start date, size in estimate days, buffer, participating teams, the stored plan's start and finish, and linked Jira trackers. Start here to find project ids.",
    obj({}),
    (ctx) => listProjects(ctx),
  ),
  readTool(
    "get_project",
    "Get a project",
    "One project in full: epics and tasks (estimates in days, specialization, skipped flag, dependencies), participating teams with their members and constraints, helpers, and the stored plan - its finish date, a summary per epic and per person, every assignment with dates, and unassigned tasks with the reason. planStale is true when re-running the plan now would change the finish.",
    obj(
      {
        project: ref("project"),
        include_assignments: {
          type: "boolean",
          description:
            "List every assignment (default true). False keeps only the per-epic and per-person summary.",
        },
      },
      ["project"],
    ),
    (ctx, args) => getProject(ctx, args),
  ),
  readTool(
    "preview_plan",
    "Preview a plan",
    "Run the scheduler on a project as it is now, without saving, and compare with the stored plan. Use it to see the effect of changes before run_plan saves them.",
    obj({ project: ref("project") }, ["project"]),
    (ctx, args) => previewPlan(ctx, args),
  ),
  readTool(
    "list_teams",
    "List teams",
    "Teams with their members: specialization, speed (1 = works at estimate) and days off, plus the projects each team takes part in. Member ids are unique across all teams.",
    obj({
      team: ref("team"),
      off_days_from: date("Only list days off on or after this date"),
    }),
    (ctx, args) => listTeams(ctx, args),
  ),
  readTool(
    "list_trackers",
    "List Jira trackers",
    "Jira trackers: which initiative each follows, its baseline project, when it was last refreshed, and the headline reading (ahead / on plan / using buffer / over buffer, variance and buffer in working days). Data is as of each tracker's last refresh in the app.",
    obj({}),
    (ctx) => listTrackers(ctx),
  ),
  readTool(
    "get_tracker",
    "Get a tracker",
    "One tracker in full: the status reading (variance, buffer used, projected and promised finish, per specialization), deadlines, the teams in it, each Jira epic with its mapping to the plan and its totals in days, counts of matched / added / unmapped issues, and the daily samples that show how the buffer was spent over time.",
    obj(
      {
        tracker: ref("tracker"),
        include_samples: {
          type: "boolean",
          description: "Include the sample history (default true).",
        },
      },
      ["tracker"],
    ),
    (ctx, args) => getTracker(ctx, args),
  ),
  readTool(
    "get_tracker_issues",
    "List a tracker's Jira issues",
    "Every Jira task of a tracker with a browse link, status, assignee, team, estimates in days, and how it relates to the plan: matched (to a plan task), added_scope (not in the plan, with the specialization doing it), unmapped (not in the plan, no specialization picked), untracked (another team's epic) or nice_to_have.",
    obj(
      {
        tracker: ref("tracker"),
        classification: {
          type: "string",
          enum: [
            "all",
            "matched",
            "added_scope",
            "unmapped",
            "untracked",
            "nice_to_have",
          ],
          description: "Only issues of this kind (default all).",
        },
      },
      ["tracker"],
    ),
    (ctx, args) => getTrackerIssues(ctx, args),
  ),
  readTool(
    "get_tracker_scope_changes",
    "Scope changes for a postmortem",
    "The facts for a postmortem or retrospective, with Jira links: work added beyond the plan (count and days, by specialization), Jira work that matches nothing, plan tasks Jira never got, estimates that changed between plan and Jira, epics left out of the plan, and the first and last buffer sample. Returns data only; write the summary from it.",
    obj({ tracker: ref("tracker") }, ["tracker"]),
    (ctx, args) => getTrackerScopeChanges(ctx, args),
  ),
  readTool(
    "get_current_view",
    "Get the current view",
    "What the Planner window is showing now: the page, and the project or tracker open in it.",
    obj({}),
    (ctx) => getCurrentView(ctx).result,
  ),

  /* --------------------------------- view --------------------------------- */
  tool(
    "view",
    "open_page",
    "Open a page",
    "Show a top-level page in the Planner window: the projects dashboard, the team page, or the tracking list.",
    obj(
      {
        page: {
          type: "string",
          enum: ["dashboard", "team", "tracking"],
          description: "Which page.",
        },
      },
      ["page"],
    ),
    (ctx, args) => openPage(ctx, args),
    { idempotent: true },
  ),
  tool(
    "view",
    "open_project",
    "Open a project",
    "Show a project (its epics, tasks and plan) in the Planner window.",
    obj({ project: ref("project") }, ["project"]),
    (ctx, args) => openProject(ctx, args),
    { idempotent: true },
  ),
  tool(
    "view",
    "open_tracker",
    "Open a tracker",
    "Show a Jira tracker in the Planner window.",
    obj({ tracker: ref("tracker") }, ["tracker"]),
    (ctx, args) => openTracker(ctx, args),
    { idempotent: true },
  ),
  tool(
    "view",
    "select_tracker_teams",
    "Select teams on a tracker",
    "Limit a tracker's reading to some of its teams (as Jira's Team field names them), or pass an empty list for every team, and show it. Saved with the tracker, like choosing teams in the app.",
    obj(
      {
        tracker: str(
          "The tracker's id or name. Omit to use the tracker open in the window.",
        ),
        teams: {
          type: "array",
          maxItems: 50,
          items: { type: "string", minLength: 1 },
          description: "Team names; empty = every team.",
        },
      },
      ["teams"],
    ),
    (ctx, args) => selectTrackerTeams(ctx, args),
    { idempotent: true },
  ),
  tool(
    "view",
    "set_plan_view",
    "Switch the plan view",
    "Show a project's plan one lane per person, one row per task, or one row per epic, and open it. Saved with the project.",
    obj(
      {
        project: str(
          "The project's id or name. Omit to use the project open in the window.",
        ),
        mode: {
          type: "string",
          enum: ["person", "task", "epic"],
          description: "How to lay out the plan.",
        },
      },
      ["mode"],
    ),
    (ctx, args) => setPlanView(ctx, args),
    { idempotent: true },
  ),

  /* --------------------------------- write -------------------------------- */
  tool(
    "write",
    "create_project",
    "Create a project",
    "Create an empty project. New projects take part with no teams until some are named here or added with set_team_inclusion.",
    obj(
      {
        name: str("The project's name."),
        start_date: date("When work starts"),
        teams: {
          type: "array",
          maxItems: 50,
          items: { type: "string", minLength: 1 },
          description: "Teams (ids or names) that take part.",
        },
      },
      ["name", "start_date"],
    ),
    (ctx, args) => createProject(ctx, args),
  ),
  tool(
    "write",
    "copy_project",
    "Copy a project",
    "Copy a project - epics, tasks, teams, helpers and settings, without its plan - to try changes on a scenario instead of the original.",
    obj(
      {
        project: ref("project"),
        name: str('Name for the copy (default "<name> (Copy)").'),
      },
      ["project"],
    ),
    (ctx, args) => copyProject(ctx, args),
  ),
  tool(
    "write",
    "update_project",
    "Update a project",
    "Change a project's name, start date, buffer (a percentage added to every estimate), note, or scheduling mode. Only the fields passed change. Call run_plan afterwards to update its plan.",
    obj(
      {
        project: ref("project"),
        name: str("New name."),
        start_date: date("New start date"),
        buffer_percent: {
          type: "number",
          minimum: 0,
          maximum: 100,
          description: "Safety buffer, 0–100 percent.",
        },
        note: {
          type: "string",
          description: "Free-text note shown on the project; empty clears it.",
        },
        plan_mode: {
          type: "string",
          enum: ["balanced", "smart"],
          description:
            "balanced: tasks in list order to whoever finishes first. smart: the freest person picks the best fitting of the next few ready tasks, aware of days off.",
        },
        lookahead: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description:
            "Smart mode only: how many upcoming tasks to choose among.",
        },
      },
      ["project"],
    ),
    (ctx, args) => updateProject(ctx, args),
    { idempotent: true },
  ),
  tool(
    "write",
    "run_plan",
    "Run the plan",
    "Re-run the scheduler for a project and save the result as its plan, exactly like the Run Plan button. Returns the previous and new finish date.",
    obj({ project: ref("project") }, ["project"]),
    (ctx, args) => runPlanTool(ctx, args),
  ),
  tool(
    "write",
    "add_epic",
    "Add an epic",
    "Add an epic at the end of a project.",
    obj(
      {
        project: ref("project"),
        name: str("The epic's name."),
        depends_on: {
          type: "array",
          maxItems: 100,
          items: { type: "string", minLength: 1 },
          description: "Epics (ids or names) that must finish first.",
        },
      },
      ["project", "name"],
    ),
    (ctx, args) => addEpic(ctx, args),
  ),
  tool(
    "write",
    "add_task",
    "Add a task",
    "Add a task at the end of an epic.",
    obj(
      {
        project: ref("project"),
        epic: ref("epic"),
        name: str("The task's name."),
        estimate_days: {
          type: "number",
          minimum: 0,
          maximum: 1000,
          description: "Estimate in working days; may be fractional (0.5).",
        },
        specialization: str(
          "Who can do it, e.g. Backend, Frontend, QA - as the team members' specializations spell it.",
        ),
        excluded: {
          type: "boolean",
          description: "Add it skipped: listed, but left out of scheduling.",
        },
        depends_on: {
          type: "array",
          maxItems: 100,
          items: { type: "string", minLength: 1 },
          description:
            "Tasks in this project (ids or names) that must finish first.",
        },
      },
      ["project", "epic", "name", "estimate_days", "specialization"],
    ),
    (ctx, args) => addTask(ctx, args),
  ),
  tool(
    "write",
    "update_task",
    "Update a task",
    "Change a task's name, estimate, specialization, skipped flag or dependencies. Only the fields passed change; depends_on replaces the whole list. Set excluded: true to skip a task (tasks are never deleted over MCP).",
    obj(
      {
        project: ref("project"),
        task: ref("task"),
        epic: str("The epic's id or name, when the task name is not unique."),
        name: str("New name."),
        estimate_days: {
          type: "number",
          minimum: 0,
          maximum: 1000,
          description: "New estimate in working days.",
        },
        specialization: str("New specialization."),
        excluded: {
          type: "boolean",
          description: "true = skipped (left out of scheduling).",
        },
        depends_on: {
          type: "array",
          maxItems: 100,
          items: { type: "string", minLength: 1 },
          description: "The full list of tasks it waits for; [] clears it.",
        },
      },
      ["project", "task"],
    ),
    (ctx, args) => updateTask(ctx, args),
    { idempotent: true },
  ),
  tool(
    "write",
    "set_member_off_days",
    "Set a person's days off",
    "Add or remove a team member's days off (holidays, leave), or replace the whole list with set. Ranges expand to weekdays. Returns the days now on file and the projects whose plans include this person, which want run_plan afterwards.",
    obj(
      {
        member: ref("team member"),
        add: dateList("Days to mark off."),
        remove: dateList("Days to mark as working again."),
        set: dateList("Replace every day off with exactly these."),
      },
      ["member"],
    ),
    (ctx, args) => setMemberOffDays(ctx, args),
    { idempotent: true },
  ),
  tool(
    "write",
    "add_team_member",
    "Add a team member",
    "Add a person to a team.",
    obj(
      {
        team: ref("team"),
        name: str("The person's name."),
        specialization: str("What they do, e.g. Backend."),
        speed: {
          type: "number",
          minimum: 0.05,
          maximum: 5,
          description:
            "Speed relative to estimates (default 1; 0.5 = half as fast).",
        },
      },
      ["team", "name", "specialization"],
    ),
    (ctx, args) => addTeamMember(ctx, args),
  ),
  tool(
    "write",
    "update_team_member",
    "Update a team member",
    "Change a person's name, specialization or speed. Only the fields passed change.",
    obj(
      {
        member: ref("team member"),
        name: str("New name."),
        specialization: str("New specialization."),
        speed: {
          type: "number",
          minimum: 0.05,
          maximum: 5,
          description: "Speed relative to estimates (1 = at estimate).",
        },
      },
      ["member"],
    ),
    (ctx, args) => updateTeamMember(ctx, args),
    { idempotent: true },
  ),
  tool(
    "write",
    "set_member_start",
    "Set when a person starts on a project",
    "Make a team member start on a project later than the project does, or clear that so they start with it.",
    obj(
      {
        project: ref("project"),
        member: ref("team member"),
        date: date("Their first day on this project"),
        clear: {
          type: "boolean",
          description: "true = start with the project again.",
        },
      },
      ["project", "member"],
    ),
    (ctx, args) => setMemberStart(ctx, args),
    { idempotent: true },
  ),
  tool(
    "write",
    "set_team_inclusion",
    "Set how a team takes part in a project",
    "Include or remove a team from a project, and set when it is available, its velocity on this project, and which epics it works on.",
    obj(
      {
        project: ref("project"),
        team: ref("team"),
        included: {
          type: "boolean",
          description:
            "false removes the team from the project (default true).",
        },
        available_from: date("The team can't start before this"),
        available_to: date("The team's work must finish by this"),
        velocity: {
          type: "number",
          minimum: 0.05,
          maximum: 5,
          description:
            "Multiplier on members' speed for this project (1 = no change).",
        },
        epics: {
          type: "array",
          maxItems: 200,
          items: { type: "string", minLength: 1 },
          description: "Only these epics (ids or names); [] = all epics.",
        },
        exclusive: {
          type: "boolean",
          description: "With epics: keep other teams off those epics.",
        },
        clear: {
          type: "array",
          maxItems: 4,
          items: {
            type: "string",
            enum: ["available_from", "available_to", "velocity", "epics"],
          },
          description: "Settings to reset to their defaults.",
        },
      },
      ["project", "team"],
    ),
    (ctx, args) => setTeamInclusion(ctx, args),
    { idempotent: true },
  ),
  tool(
    "write",
    "add_helper",
    "Add a helper",
    "Bring an outside person into one project for a window of time (a contractor, someone lent from another team).",
    obj(
      {
        project: ref("project"),
        name: str("The helper's name."),
        specialization: str("What they do, e.g. QA."),
        speed: {
          type: "number",
          minimum: 0.05,
          maximum: 5,
          description: "Speed relative to estimates (default 1).",
        },
        available_from: date("First day they can work"),
        available_to: date("Last day they can work"),
        off_days: dateList("Their days off within that window."),
      },
      ["project", "name", "specialization", "available_from", "available_to"],
    ),
    (ctx, args) => addHelper(ctx, args),
  ),
];

const BY_NAME = new Map(ENTRIES.map((e) => [e.name, e]));

/** Every tool's public definition, in catalogue order. */
export const TOOL_DEFINITIONS: readonly ToolDefinition[] = ENTRIES.map(
  ({ run: _run, ...def }) => def,
);

/** The tools a client may see with the given settings. */
export function availableTools(options: {
  allowWrites: boolean;
}): ToolDefinition[] {
  return TOOL_DEFINITIONS.filter(
    (t) => t.access !== "write" || options.allowWrites,
  );
}

export function toolAccess(name: string): ToolAccess | null {
  return BY_NAME.get(name)?.access ?? null;
}

/**
 * Run one tool against the current state. Throws {@link ToolError} for a
 * request that cannot be carried out, with a message meant for the model.
 */
export function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
  options: { allowWrites: boolean },
): ToolOutcome {
  const entry = BY_NAME.get(name);
  if (!entry) throw new ToolError(`Unknown tool: ${name}`);
  if (entry.access === "write" && !options.allowWrites) {
    throw new ToolError(
      "Changes are turned off. The user can allow them in Planner: About → AI assistants → Allow changes.",
    );
  }
  const problem = checkArgs(entry.inputSchema, args);
  if (problem) throw new ToolError(problem);
  return entry.run(ctx, args as never);
}

/** Shown to the model once per session. */
export const SERVER_INSTRUCTIONS = `Planner is a capacity-planning app: projects made of epics and tasks with estimates in working days, teams of people with specializations, speeds and days off, a scheduler that turns them into a dated plan, and Jira trackers that compare live Jira progress with a project's plan.

- Arguments that name a project, epic, task, team, member or tracker take its id or its exact name (case-insensitive). Ids are safest; list_projects, get_project, list_teams and list_trackers return them.
- Dates are YYYY-MM-DD. Days off and helper windows accept ranges as YYYY-MM-DD..YYYY-MM-DD (weekdays only).
- Changes go to the user's real data and sync to their other devices. There is no undo, and nothing can be deleted over MCP. To try something out, copy_project first and change the copy.
- A stored plan does not update itself: after changing estimates, people, days off or dates, call run_plan (or preview_plan to look without saving).
- Tracker data is as of the last refresh in the app; this server cannot refresh from Jira or write to it.`;
