import {
  allMembers,
  autoTaskMap,
  jiraIssueEstimate,
  type Epic,
  type ID,
  type JiraIssue,
  type JiraSnapshot,
  type Project,
  type TaskItem,
  type Team,
  type Tracker,
} from "@planner/core";

/**
 * Build a fresh Planner project from what an initiative looks like in Jira
 * *today*.
 *
 * A baseline plan drifts away from its initiative: epics get renamed, split
 * into milestones, and tasks move between them, until matching the two by name
 * stops working. Rebuilding the plan from Jira sidesteps that — every task is a
 * Jira issue, so the tracker's task map is exact by construction — while the
 * staffing (teams, helpers, member starts, buffer, plan mode) is copied from a
 * template project, because Jira knows nothing about who is available when.
 *
 * **Status is ignored on purpose.** Done issues are imported like open ones:
 * the point is to re-plan the *whole* scope from the project start and let the
 * tracker's earned schedule say how far along it is. Leaving finished work out
 * would make any in-flight initiative look freshly started.
 *
 * **Estimates are the original estimate.** Remaining time would shrink as the
 * work progresses and turn the plan into a moving target. An issue with no
 * original estimate falls back to logged + remaining time; one with neither is
 * imported as a skipped task with 0 days, visible and easy to fix, rather than
 * silently scheduled as a one-day task.
 *
 * **Specialization is inferred**, most trustworthy first: the matching task in
 * the template plan (via the tracker's task map, so manual corrections count),
 * then a Jira label naming one ("backend"), then one named in the summary as a
 * whole word ("Wallet QA pass"), then the Jira assignee's specialization on a
 * team, then the most common one among the rest of the epic, then the
 * caller's default.
 *
 * **Tags are words that name a specialization**, in a label or a summary. Every
 * specialization someone on a team (or a helper, or the template) has is a tag
 * for itself. On top of that come {@link BUILT_IN_TAG_ALIASES} — "java" means
 * Backend, but only while nobody's specialization is literally "Java" — and
 * the caller's own `tagAliases`, which win over both. Labels and bracketed
 * summary tags ("[Tools] level editor") that name nothing are reported in
 * `unknownTags`, so the caller can offer to map them.
 *
 * Pure like the rest of this package: ids come from `newId` and nothing reads
 * the clock (the note is dated from the snapshot).
 */

export type EstimateSource = "original" | "logged" | "none";
export type SpecializationSource =
  "plan" | "tag" | "name" | "assignee" | "epic" | "default";

/** A word or phrase that, found in a label or summary, names a specialization. */
export interface TagAlias {
  tag: string;
  specialization: string;
}

/**
 * Tags every import understands without being told. Each applies only while
 * its tag is not itself somebody's specialization and its target is, matched
 * case-insensitively — so a site with a "Java" team keeps Java separate.
 */
export const BUILT_IN_TAG_ALIASES: readonly TagAlias[] = [
  { tag: "java", specialization: "Backend" },
];

export interface ImportedTask {
  issueKey: string;
  taskId: ID;
  epicId: ID;
  estimateSource: EstimateSource;
  specializationSource: SpecializationSource;
}

export interface ProjectFromSnapshotOptions {
  snapshot: JiraSnapshot;
  projectId: ID;
  name: string;
  startDate: string;
  newId: () => ID;
  /** Every team, for matching Jira assignees to specializations. */
  teams: Team[];
  /** For tasks nothing else gives a specialization to. */
  defaultSpecialization: string;
  /** Extra tags, applied over the built-in ones. Blank rows are ignored. */
  tagAliases?: TagAlias[];
  /** Hours in one Planner day. Absent = 8. */
  hoursPerDay?: number;
  /** Project whose staffing is copied and whose tasks lend specializations. */
  template?: Project;
  /** The tracker's map onto `template`, so manual matches are honoured. */
  templateTaskMap?: Tracker["taskMap"];
  /** Overrides the template's buffer percentage. */
  buffer?: number;
}

export interface ProjectFromSnapshot {
  project: Project;
  /** Jira issue key -> the task created for it. Exact, never guessed. */
  taskMap: { [jiraIssueKey: string]: ID };
  /** One row per imported issue, in project order. */
  tasks: ImportedTask[];
  /** Jira epics that had no child issues and so made no epic. */
  emptyEpics: string[];
  /** Tags on the issues that name no specialization, most used first. */
  unknownTags: UnknownTag[];
}

export interface UnknownTag {
  /** As first seen in Jira, e.g. "tooling" or "Tools". */
  tag: string;
  /** Keys of the issues carrying it, in project order. */
  issueKeys: string[];
}

function normPerson(s: string): string {
  return String(s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function keyNumber(key: string): number {
  const n = Number(key.slice(key.lastIndexOf("-") + 1));
  return Number.isFinite(n) ? n : 0;
}

/** Lowercased words, so "[QA]" and "backend:" both yield their word. */
function words(s: string): string[] {
  return String(s ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w !== "");
}

function phrase(s: string): string {
  return words(s).join(" ");
}

/**
 * Tag phrase -> the specialization it names. Later layers win: built-in
 * aliases, then every known specialization as a tag for itself, then the
 * caller's aliases.
 */
export function tagLookup(
  known: string[],
  aliases: readonly TagAlias[] = [],
): Map<string, string> {
  const byPhrase = new Map<string, string>();
  for (const spec of known) {
    const p = phrase(spec);
    if (p && !byPhrase.has(p)) byPhrase.set(p, spec);
  }
  const lookup = new Map<string, string>();
  for (const alias of BUILT_IN_TAG_ALIASES) {
    const tag = phrase(alias.tag);
    const target = byPhrase.get(phrase(alias.specialization));
    if (tag && target && !byPhrase.has(tag)) lookup.set(tag, target);
  }
  for (const [p, spec] of byPhrase) lookup.set(p, spec);
  for (const alias of aliases) {
    const tag = phrase(alias.tag);
    const spec = alias.specialization.trim();
    if (!tag || !spec) continue;
    lookup.set(tag, byPhrase.get(phrase(spec)) ?? spec);
  }
  return lookup;
}

/** A summary's bracketed tags: "[Tools][UI] editor" -> ["Tools", "UI"]. */
function bracketTags(summary: string): string[] {
  return [...String(summary ?? "").matchAll(/\[([^\]]+)\]/g)]
    .map((m) => m[1].trim())
    .filter((t) => t !== "");
}

/**
 * The one specialization some texts name, as whole words or phrases. Two
 * named at once ("Backend + QA handover") is ambiguous, so it names none; two
 * tags for the same one ("Java backend") are not.
 */
function namedSpecialization(
  texts: string[],
  lookup: Map<string, string>,
): string | undefined {
  const hits = new Set<string>();
  for (const text of texts) {
    const hay = ` ${phrase(text)} `;
    for (const [tag, spec] of lookup) {
      if (hay.includes(` ${tag} `)) hits.add(spec);
    }
  }
  return hits.size === 1 ? [...hits][0] : undefined;
}

/**
 * The specialization an issue's tags name: its Jira labels first, then the
 * bracketed tags in its summary ("[QA] smoke pass"). Undefined when neither
 * names one, or when one names two at once.
 */
export function issueTagSpecialization(
  issue: Pick<JiraIssue, "labels" | "summary">,
  lookup: Map<string, string>,
): string | undefined {
  return (
    namedSpecialization(issue.labels ?? [], lookup) ??
    namedSpecialization(bracketTags(issue.summary), lookup)
  );
}

/**
 * Jira search has no inherent order and the snapshot does not carry rank, so
 * sort on what the team has told Jira about timing: start date, then due date
 * (milestone epics usually carry one), then creation order.
 */
function byTiming(a: JiraIssue, b: JiraIssue): number {
  const as = a.startDate ?? "￿";
  const bs = b.startDate ?? "￿";
  if (as !== bs) return as < bs ? -1 : 1;
  const ad = a.dueDate ?? "￿";
  const bd = b.dueDate ?? "￿";
  if (ad !== bd) return ad < bd ? -1 : 1;
  return keyNumber(a.key) - keyNumber(b.key);
}

/**
 * One Jira issue's estimate in Planner days: the original estimate, else
 * logged + remaining time, else none.
 */
export function estimateOf(
  issue: JiraIssue,
  hoursPerDay: number | undefined,
): { days: number; source: EstimateSource } {
  // One reading of Jira's size, shared with the tracker's added scope.
  return jiraIssueEstimate(issue, hoursPerDay);
}

function mostCommon(values: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | undefined;
  let bestCount = 0;
  // Map iteration is insertion order, so a tie goes to the first one seen.
  for (const [v, n] of counts) {
    if (n > bestCount) {
      best = v;
      bestCount = n;
    }
  }
  return best;
}

export function projectFromSnapshot(
  options: ProjectFromSnapshotOptions,
): ProjectFromSnapshot {
  const { snapshot, template, newId, hoursPerDay } = options;

  // Template task each Jira issue corresponds to, if any.
  const templateTasks = new Map<ID, TaskItem>();
  for (const epic of template?.epics ?? []) {
    for (const task of epic.tasks) templateTasks.set(task.id, task);
  }
  const matched = template
    ? autoTaskMap(template, snapshot, options.templateTaskMap)
    : {};
  const templateTaskFor = (key: string): TaskItem | undefined => {
    const id = matched[key];
    return id ? templateTasks.get(id) : undefined;
  };

  const knownSpecs = new Set<string>();
  for (const member of allMembers(options.teams)) {
    if (member.specialization) knownSpecs.add(member.specialization);
  }
  for (const helper of template?.helpers ?? []) {
    if (helper.specialization) knownSpecs.add(helper.specialization);
  }
  for (const task of templateTasks.values()) {
    if (task.specialization) knownSpecs.add(task.specialization);
  }
  const lookup = tagLookup([...knownSpecs], options.tagAliases);

  const specByPerson = new Map<string, string>();
  for (const member of allMembers(options.teams)) {
    const name = normPerson(member.name);
    if (name && member.specialization && !specByPerson.has(name)) {
      specByPerson.set(name, member.specialization);
    }
  }

  const epics: Epic[] = [];
  const tasks: ImportedTask[] = [];
  const taskMap: { [jiraIssueKey: string]: ID } = {};
  const emptyEpics: string[] = [];
  const unknown = new Map<string, UnknownTag>();
  const noteUnknownTags = (issue: JiraIssue) => {
    for (const tag of [
      ...(issue.labels ?? []),
      ...bracketTags(issue.summary),
    ]) {
      const p = phrase(tag);
      if (!p || lookup.has(p)) continue;
      const entry = unknown.get(p) ?? { tag, issueKeys: [] };
      if (!entry.issueKeys.includes(issue.key)) entry.issueKeys.push(issue.key);
      unknown.set(p, entry);
    }
  };
  const seen = new Set<string>();
  // Template task id -> new task id, for carrying dependencies across.
  const fromTemplate = new Map<ID, ID>();
  const pendingDeps: { task: TaskItem; templateDeps: ID[] }[] = [];

  for (const jiraEpic of [...(snapshot.epics ?? [])].sort(byTiming)) {
    const children = (jiraEpic.children ?? [])
      .filter((issue) => issue.key && !seen.has(issue.key))
      .sort(byTiming);
    if (children.length === 0) {
      emptyEpics.push(jiraEpic.key);
      continue;
    }

    const epicId = newId();
    const rows: {
      issue: JiraIssue;
      task: TaskItem;
      info: ImportedTask;
    }[] = [];

    for (const issue of children) {
      seen.add(issue.key);
      noteUnknownTags(issue);
      const estimate = estimateOf(issue, hoursPerDay);
      const planTask = templateTaskFor(issue.key);
      const tagSpec = namedSpecialization(issue.labels ?? [], lookup);
      const nameSpec = namedSpecialization([issue.summary], lookup);
      const assigneeSpec = issue.assignee
        ? specByPerson.get(normPerson(issue.assignee.displayName))
        : undefined;
      let specialization = "";
      let specializationSource: SpecializationSource = "default";
      if (planTask?.specialization) {
        specialization = planTask.specialization;
        specializationSource = "plan";
      } else if (tagSpec) {
        specialization = tagSpec;
        specializationSource = "tag";
      } else if (nameSpec) {
        specialization = nameSpec;
        specializationSource = "name";
      } else if (assigneeSpec) {
        specialization = assigneeSpec;
        specializationSource = "assignee";
      }

      const task: TaskItem = {
        id: newId(),
        name: issue.summary || issue.key,
        estimateDays: estimate.days,
        specialization,
        excluded: estimate.source === "none",
      };
      if (planTask) {
        if (!fromTemplate.has(planTask.id))
          fromTemplate.set(planTask.id, task.id);
        if (planTask.dependsOn && planTask.dependsOn.length > 0) {
          pendingDeps.push({ task, templateDeps: planTask.dependsOn });
        }
      }
      rows.push({
        issue,
        task,
        info: {
          issueKey: issue.key,
          taskId: task.id,
          epicId,
          estimateSource: estimate.source,
          specializationSource,
        },
      });
    }

    const epicSpec = mostCommon(
      rows.map((r) => r.task.specialization).filter((s) => s !== ""),
    );
    for (const row of rows) {
      if (row.task.specialization !== "") continue;
      row.task.specialization = epicSpec ?? options.defaultSpecialization;
      row.info.specializationSource = epicSpec ? "epic" : "default";
    }

    for (const row of rows) {
      taskMap[row.issue.key] = row.task.id;
      tasks.push(row.info);
    }
    epics.push({
      id: epicId,
      name: jiraEpic.summary || jiraEpic.key,
      tasks: rows.map((r) => r.task),
    });
  }

  // A dependency survives only when both ends made it into the new project.
  for (const { task, templateDeps } of pendingDeps) {
    const deps = templateDeps
      .map((id) => fromTemplate.get(id))
      .filter((id): id is ID => id !== undefined && id !== task.id);
    if (deps.length > 0) task.dependsOn = [...new Set(deps)];
  }

  const project: Project = {
    id: options.projectId,
    name: options.name,
    startDate: options.startDate,
    note:
      `Built from Jira ${snapshot.initiative.key} ` +
      `(${snapshot.fetchedAt.slice(0, 10)}) using original estimates.`,
    epics,
    plan: null,
    planViewMode: "person",
    helpers: (template?.helpers ?? []).map((h) => ({ ...h, id: newId() })),
    memberStarts: { ...(template?.memberStarts ?? {}) },
    // Epic owners and epic-scoped teams name the template's epics, which have
    // no counterpart here — the whole reason for rebuilding is that the epics
    // no longer line up. Team windows and velocities still apply.
    epicAssignments: {},
  };
  if (template?.teamInclusions) {
    project.teamInclusions = template.teamInclusions.map((inc) => {
      const next = { ...inc };
      delete next.epicIds;
      delete next.exclusive;
      return next;
    });
  }
  const buffer = options.buffer ?? template?.buffer;
  if (buffer !== undefined) project.buffer = buffer;
  if (template?.planMode) project.planMode = template.planMode;
  if (template?.planLookahead !== undefined) {
    project.planLookahead = template.planLookahead;
  }

  const unknownTags = [...unknown.values()].sort(
    (a, b) =>
      b.issueKeys.length - a.issueKeys.length || a.tag.localeCompare(b.tag),
  );
  return { project, taskMap, tasks, emptyEpics, unknownTags };
}
