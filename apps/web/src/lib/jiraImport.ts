/**
 * "Rebuild the plan from Jira", minus the React.
 *
 * The modal shows a preview of exactly what will be created — the project, its
 * plan, and the tracker reading against it — so the numbers the user approves
 * are the numbers that land. Everything is computed here, from inputs the
 * modal holds, and `commit` dispatches the very objects the preview showed.
 */
import {
  allMembers,
  baselinePlans,
  runPlan,
  sampleFromStatus,
  trackerStatus,
  type AppState,
  type BaselinePlans,
  type ID,
  type JiraSnapshot,
  type Project,
  type Tracker,
  type TrackerStatus,
} from "@planner/core";
import {
  projectFromSnapshot,
  type ProjectFromSnapshot,
  type SpecializationSource,
  type TagAlias,
} from "@planner/jira";

/** Where the new plan is compared with Jira. */
export type TrackChoice =
  /** A new tracker, leaving every existing one (and its history) alone. */
  | { kind: "new" }
  /** Switch this existing tracker's baseline to the new project. */
  | { kind: "switch"; trackerId: ID }
  | { kind: "none" };

export interface JiraImportChoices {
  name: string;
  startDate: string;
  /** Project to copy staffing from; null = every team, no helpers. */
  templateId: ID | null;
  /** Buffer percentage, 0–100. */
  buffer: number;
  defaultSpecialization: string;
  /** Extra label/summary words that name a specialization. */
  tagAliases: TagAlias[];
  hoursPerDay: number;
  track: TrackChoice;
}

/** The initiative being imported, as a tracker would know it. */
export interface JiraImportSource {
  snapshot: JiraSnapshot;
  initiativeUrl: string;
  initiativeKey: string;
  baseUrl: string;
}

/**
 * A stored snapshot with every list present.
 *
 * Snapshots are read back from the database as-is, and ones saved by older
 * versions have epics without `children`. Normalising once, where a snapshot
 * enters the import, keeps every later step from having to remember that.
 */
export function normalizeSnapshot(snapshot: JiraSnapshot): JiraSnapshot {
  return {
    ...snapshot,
    fetchedAt: snapshot.fetchedAt ?? "",
    fieldIds: snapshot.fieldIds ?? {},
    epics: (snapshot.epics ?? []).map((epic) => ({
      ...epic,
      children: epic.children ?? [],
    })),
  };
}

/** Issues a snapshot would import; 0 means it predates child issues. */
export function snapshotIssueCount(snapshot: JiraSnapshot): number {
  const keys = new Set<string>();
  for (const epic of snapshot.epics ?? []) {
    for (const child of epic.children ?? []) if (child.key) keys.add(child.key);
  }
  return keys.size;
}

export interface JiraImportSide {
  project: Project;
  plans: BaselinePlans;
  status: TrackerStatus;
  estimateDays: number;
  unassigned: number;
}

export interface JiraImportPreview {
  built: ProjectFromSnapshot;
  rebuilt: JiraImportSide;
  /** The template, measured the way its tracker measures it today. */
  current?: JiraImportSide;
  specSources: Record<SpecializationSource, number>;
  unestimated: number;
  /** Specializations tasks need that nobody on the included teams has. */
  missingSpecializations: string[];
}

function estimateTotal(project: Project): number {
  let total = 0;
  for (const epic of project.epics) {
    for (const t of epic.tasks) if (!t.excluded) total += t.estimateDays;
  }
  return total;
}

function side(
  project: Project,
  tracker: Tracker,
  state: AppState,
  today: string,
): JiraImportSide {
  return {
    project,
    plans: baselinePlans(project, state.teams),
    status: trackerStatus(tracker, project, state.teams, today),
    estimateDays: estimateTotal(project),
    unassigned: project.plan?.unassigned.length ?? 0,
  };
}

/** The tracker the template is measured through, if one points at it. */
function templateTracker(
  state: AppState,
  source: JiraImportSource,
  templateId: ID,
): Tracker | undefined {
  const trackers = state.trackers ?? [];
  return (
    trackers.find(
      (t) =>
        t.projectId === templateId && t.initiativeKey === source.initiativeKey,
    ) ?? trackers.find((t) => t.projectId === templateId)
  );
}

export function previewJiraImport(input: {
  source: JiraImportSource;
  state: AppState;
  choices: JiraImportChoices;
  projectId: ID;
  newId: () => ID;
  today: string;
  now: string;
}): JiraImportPreview {
  const { source, state, choices, today, now } = input;
  const template = choices.templateId
    ? state.projects.find((p) => p.id === choices.templateId)
    : undefined;
  const viaTracker = template
    ? templateTracker(state, source, template.id)
    : undefined;

  const built = projectFromSnapshot({
    snapshot: source.snapshot,
    projectId: input.projectId,
    name: choices.name.trim() || source.snapshot.initiative.summary,
    startDate: choices.startDate,
    newId: input.newId,
    teams: state.teams,
    defaultSpecialization: choices.defaultSpecialization,
    tagAliases: choices.tagAliases,
    hoursPerDay: choices.hoursPerDay,
    template,
    templateTaskMap: viaTracker?.taskMap,
    buffer: choices.buffer,
  });
  const project: Project = {
    ...built.project,
    plan: runPlan(built.project, state.teams, now, {
      mode: built.project.planMode ?? "balanced",
      lookahead: built.project.planLookahead ?? 5,
    }),
  };
  built.project = project;

  const probe: Tracker = {
    id: "",
    name: "",
    initiativeUrl: source.initiativeUrl,
    initiativeKey: source.initiativeKey,
    baseUrl: source.baseUrl,
    projectId: project.id,
    hoursPerDay: choices.hoursPerDay,
    taskMap: built.taskMap,
    snapshot: source.snapshot,
  };
  const rebuilt = side(project, probe, state, today);

  let current: JiraImportSide | undefined;
  if (template) {
    current = side(
      template,
      {
        ...probe,
        ...(viaTracker ?? {}),
        projectId: template.id,
        snapshot: source.snapshot,
        taskMap: viaTracker?.taskMap,
      },
      state,
      today,
    );
  }

  const specSources: Record<SpecializationSource, number> = {
    plan: 0,
    tag: 0,
    name: 0,
    assignee: 0,
    epic: 0,
    default: 0,
  };
  for (const t of built.tasks) specSources[t.specializationSource]++;

  const offered = new Set<string>();
  const inclusions = project.teamInclusions;
  const teams = inclusions
    ? state.teams.filter((t) => inclusions.some((i) => i.teamId === t.id))
    : state.teams;
  for (const m of allMembers(teams)) offered.add(m.specialization);
  for (const h of project.helpers ?? []) offered.add(h.specialization);
  const needed = new Set<string>();
  for (const epic of project.epics) {
    for (const t of epic.tasks) if (!t.excluded) needed.add(t.specialization);
  }

  return {
    built,
    rebuilt,
    current,
    specSources,
    unestimated: built.tasks.filter((t) => t.estimateSource === "none").length,
    missingSpecializations: [...needed].filter((s) => !offered.has(s)).sort(),
  };
}

/** The store actions `commitJiraImport` needs — a slice of `useAppStore()`. */
export interface JiraImportActions {
  addProject: (project: Project) => void;
  addTracker: (tracker: Tracker) => void;
  setTrackerTaskMap: (id: ID, taskMap: NonNullable<Tracker["taskMap"]>) => void;
  setTrackerProject: (id: ID, projectId: ID | null) => void;
  setTrackerSnapshot: (
    id: ID,
    snapshot: JiraSnapshot,
    sample: ReturnType<typeof sampleFromStatus> | null,
  ) => void;
}

/**
 * Create what the preview showed. Returns the tracker the new plan is measured
 * through, if any.
 */
export function commitJiraImport(input: {
  preview: JiraImportPreview;
  source: JiraImportSource;
  choices: JiraImportChoices;
  actions: JiraImportActions;
  newId: () => ID;
  defaultHoursPerDay: number;
}): ID | null {
  const { preview, source, choices, actions } = input;
  const { project, taskMap } = preview.built;
  const status = preview.rebuilt.status;
  const sample =
    status.kind === "no-baseline" ? null : sampleFromStatus(status);

  actions.addProject(project);

  if (choices.track.kind === "new") {
    const tracker: Tracker = {
      id: input.newId(),
      name: `${source.initiativeKey} · ${project.name}`,
      initiativeUrl: source.initiativeUrl,
      initiativeKey: source.initiativeKey,
      baseUrl: source.baseUrl,
      projectId: project.id,
      taskMap: { ...taskMap },
      snapshot: source.snapshot,
      samples: sample ? [sample] : [],
    };
    if (choices.hoursPerDay !== input.defaultHoursPerDay) {
      tracker.hoursPerDay = choices.hoursPerDay;
    }
    actions.addTracker(tracker);
    return tracker.id;
  }

  if (choices.track.kind === "switch") {
    const id = choices.track.trackerId;
    actions.setTrackerTaskMap(id, { ...taskMap });
    actions.setTrackerProject(id, project.id);
    actions.setTrackerSnapshot(id, source.snapshot, sample);
    return id;
  }

  return null;
}

/** Sensible first choices, so the common case is one click. */
export function defaultJiraImportChoices(input: {
  source: JiraImportSource;
  state: AppState;
  /** The tracker the import was started from, if any. */
  fromTracker?: Tracker;
  hoursPerDay: number;
  today: string;
  /** Tag mappings remembered from the last import. */
  tagAliases?: TagAlias[];
}): JiraImportChoices {
  const { source, state, fromTracker } = input;
  const sameInitiative = (state.trackers ?? []).find(
    (t) => t.initiativeKey === source.initiativeKey && t.projectId,
  );
  const templateId =
    fromTracker?.projectId ?? sameInitiative?.projectId ?? null;
  const template = templateId
    ? state.projects.find((p) => p.id === templateId)
    : undefined;

  return {
    name: `${source.snapshot.initiative.summary} (Jira ${source.snapshot.fetchedAt.slice(0, 10)})`,
    startDate:
      template?.startDate ?? earliestStart(source.snapshot) ?? input.today,
    templateId: template?.id ?? null,
    buffer: template?.buffer ?? 0,
    defaultSpecialization: commonSpecialization(state, template),
    tagAliases: (input.tagAliases ?? []).map((a) => ({ ...a })),
    hoursPerDay: fromTracker?.hoursPerDay ?? input.hoursPerDay,
    track: { kind: "new" },
  };
}

function earliestStart(snapshot: JiraSnapshot): string | undefined {
  let out: string | undefined;
  for (const epic of snapshot.epics ?? []) {
    for (const d of [
      epic.startDate,
      ...(epic.children ?? []).map((c) => c.startDate),
    ]) {
      if (d && (out === undefined || d < out)) out = d;
    }
  }
  return out;
}

/** Every specialization Planner knows of, most used first. */
export function knownSpecializations(state: AppState): string[] {
  const counts = new Map<string, number>();
  const bump = (s: string) => {
    if (s) counts.set(s, (counts.get(s) ?? 0) + 1);
  };
  for (const m of allMembers(state.teams)) bump(m.specialization);
  for (const p of state.projects) {
    for (const e of p.epics) for (const t of e.tasks) bump(t.specialization);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([s]) => s);
}

/** Every specialization somebody on a team has, alphabetically. */
export function teamSpecializations(state: AppState): string[] {
  const specs = new Set<string>();
  for (const m of allMembers(state.teams)) {
    const s = m.specialization.trim();
    if (s) specs.add(s);
  }
  return [...specs].sort((a, b) => a.localeCompare(b));
}

function commonSpecialization(state: AppState, template?: Project): string {
  if (template) {
    const counts = new Map<string, number>();
    for (const e of template.epics) {
      for (const t of e.tasks) {
        counts.set(t.specialization, (counts.get(t.specialization) ?? 0) + 1);
      }
    }
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best?.[0]) return best[0];
  }
  return knownSpecializations(state)[0] ?? "General";
}
