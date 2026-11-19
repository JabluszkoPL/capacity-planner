import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useNavigate } from "react-router-dom";
import { newId, todayISO, type Tracker } from "@planner/core";
import {
  parseIssueLink,
  type SpecializationSource,
  type TagAlias,
  type UnknownTag,
} from "@planner/jira";
import { useAppStore } from "@planner/client-runtime";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { useToast } from "../ui/Toast";
import { ErrorBoundary, ErrorPanel } from "../ui/ErrorBoundary";
import { days, statusLabel } from "./StatusPanel";
import { createJiraTransport } from "../../lib/jiraTransport";
import { isJiraConfigured } from "../../lib/jiraSettings";
import { useJiraSettings } from "../../lib/useJiraSettings";
import { refreshTracker } from "../../lib/refreshTracker";
import { readTagAliases, writeTagAliases } from "../../lib/tagAliases";
import {
  commitJiraImport,
  defaultJiraImportChoices,
  knownSpecializations,
  normalizeSnapshot,
  previewJiraImport,
  snapshotIssueCount,
  teamSpecializations,
  type JiraImportChoices,
  type JiraImportPreview,
  type JiraImportSide,
  type JiraImportSource,
} from "../../lib/jiraImport";
import "./tracking.css";

interface JiraImportModalProps {
  open: boolean;
  onClose: () => void;
  /** Start from this tracker's last snapshot instead of downloading. */
  tracker?: Tracker;
}

/**
 * Build a new project from a Jira initiative and compare it with the plan the
 * initiative is tracked against today.
 *
 * The body is only mounted while open, so every opening starts from fresh
 * defaults rather than whatever was half-typed last time.
 */
export function JiraImportModal({
  open,
  onClose,
  tracker,
}: JiraImportModalProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New plan from a Jira initiative"
      className="jira-import"
    >
      {/* A crash in here must not take the whole page down with it. */}
      <ErrorBoundary
        fallback={(error) => (
          <>
            <ErrorPanel title="Couldn't build the plan" error={error}>
              <p className="muted">
                Nothing was created. Refreshing the tracker and trying again
                often helps; if not, send this message along.
              </p>
            </ErrorPanel>
            <div className="modal-actions">
              <Button onClick={onClose}>Close</Button>
            </div>
          </>
        )}
      >
        <ImportBody onClose={onClose} tracker={tracker} />
      </ErrorBoundary>
    </Modal>
  );
}

function sourceOf(tracker: Tracker | undefined): JiraImportSource | null {
  if (!tracker?.snapshot) return null;
  return {
    snapshot: normalizeSnapshot(tracker.snapshot),
    initiativeUrl: tracker.initiativeUrl,
    initiativeKey: tracker.initiativeKey,
    baseUrl: tracker.baseUrl,
  };
}

function ImportBody({
  onClose,
  tracker,
}: {
  onClose: () => void;
  tracker?: Tracker;
}) {
  const [source, setSource] = useState(() => sourceOf(tracker));
  if (!source) return <DownloadStep onLoaded={setSource} onClose={onClose} />;
  if (snapshotIssueCount(source.snapshot) === 0) {
    return (
      <div>
        <p className="warn-box">
          This snapshot of {source.initiativeKey} has no child issues to plan.
          {tracker
            ? " It was probably saved by an older version of Planner — press Refresh on the tracker, then try again."
            : " Check that the initiative has epics with issues under them."}
        </p>
        <div className="modal-actions">
          <Button onClick={onClose}>Close</Button>
        </div>
      </div>
    );
  }
  return <PreviewStep source={source} tracker={tracker} onClose={onClose} />;
}

/* ------------------------------ download step ----------------------------- */

const LINK_MESSAGES: Record<string, string> = {
  "no-key":
    "That link has no issue key in it. Paste a link to the initiative, or its key like ABC-123.",
  "no-host":
    "Planner can't tell which Jira site that is. Paste the full link, or set your Jira URL in Jira settings.",
  "untrusted-host": "That link doesn't point at a Jira site.",
};

function DownloadStep({
  onLoaded,
  onClose,
}: {
  onLoaded: (source: JiraImportSource) => void;
  onClose: () => void;
}) {
  const { state } = useAppStore();
  const settings = useJiraSettings();
  const transport = useMemo(() => createJiraTransport(), []);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputId = useId();
  const connected = isJiraConfigured(settings);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const raw = value.trim();
    if (!raw || busy) return;
    const parsed = parseIssueLink(raw, settings.baseUrl || undefined);
    if (!parsed.ok) {
      setError(LINK_MESSAGES[parsed.reason] ?? "That link could not be read.");
      return;
    }
    setError(null);
    setBusy(true);
    // A throwaway tracker: refreshTracker already knows how to download an
    // initiative and word every way that can fail.
    const result = await refreshTracker({
      tracker: {
        id: "",
        name: parsed.key,
        initiativeUrl: raw,
        initiativeKey: parsed.key,
        baseUrl: parsed.baseUrl,
      },
      settings,
      transport,
      state,
      today: todayISO(),
      now: new Date().toISOString(),
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    onLoaded({
      snapshot: normalizeSnapshot(result.snapshot),
      initiativeUrl: raw,
      initiativeKey: parsed.key,
      baseUrl: parsed.baseUrl,
    });
  }

  return (
    <form onSubmit={submit}>
      <p className="modal-hint">
        Downloads the initiative's epics and child issues and turns them into a
        project: one task per issue, sized by its original estimate. Status is
        ignored, so finished work is planned too and the tracker can say how far
        along you are.
      </p>
      {!connected && (
        <div className="warn-box">
          Connect Jira first (Tracking → Connect Jira).
        </div>
      )}
      <label className="modal-field-label" htmlFor={inputId}>
        Initiative link or key
      </label>
      <input
        id={inputId}
        type="text"
        className="jira-import-link"
        value={value}
        placeholder="https://your-company.atlassian.net/browse/ABC-123"
        aria-invalid={error !== null}
        aria-describedby={error ? `${inputId}-error` : undefined}
        onChange={(e) => {
          setValue(e.target.value);
          if (error) setError(null);
        }}
      />
      {error && (
        <p className="field-error" id={`${inputId}-error`} role="alert">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <Button onClick={onClose}>Cancel</Button>
        <Button
          type="submit"
          variant="primary"
          disabled={!value.trim() || busy || !connected}
        >
          {busy ? "Downloading…" : "Download"}
        </Button>
      </div>
    </form>
  );
}

/* ------------------------------ preview step ------------------------------ */

const SOURCE_WORDS: Record<SpecializationSource, string> = {
  plan: "from the old plan",
  tag: "from a Jira label",
  name: "named in the summary",
  assignee: "from the assignee",
  epic: "from the epic",
  default: "default",
};

function PreviewStep({
  source,
  tracker,
  onClose,
}: {
  source: JiraImportSource;
  tracker?: Tracker;
  onClose: () => void;
}) {
  const { state, actions } = useAppStore();
  const settings = useJiraSettings();
  const navigate = useNavigate();
  const toast = useToast();
  const id = useId();

  // Fixed for the life of the dialog, so the preview is stable while editing.
  const [clock] = useState(() => ({
    today: todayISO(),
    now: new Date().toISOString(),
  }));
  const [projectId] = useState(() => newId());
  const [choices, setChoices] = useState<JiraImportChoices>(() =>
    defaultJiraImportChoices({
      source,
      state,
      fromTracker: tracker,
      hoursPerDay: settings.hoursPerDay,
      today: clock.today,
      tagAliases: readTagAliases(),
    }),
  );
  const set = (patch: Partial<JiraImportChoices>) =>
    setChoices((c) => ({ ...c, ...patch }));

  const preview = useMemo(
    () =>
      previewJiraImport({
        source,
        state,
        choices,
        projectId,
        newId,
        today: clock.today,
        now: clock.now,
      }),
    [source, state, choices, projectId, clock],
  );

  const specs = useMemo(() => knownSpecializations(state), [state]);
  const teamSpecs = useMemo(() => teamSpecializations(state), [state]);
  const sameInitiative = (state.trackers ?? []).filter(
    (t) => t.initiativeKey === source.initiativeKey,
  );
  const trackValue =
    choices.track.kind === "switch"
      ? `switch:${choices.track.trackerId}`
      : choices.track.kind;
  const taskCount = preview.built.tasks.length;

  function create() {
    writeTagAliases(choices.tagAliases);
    const trackerId = commitJiraImport({
      preview,
      source,
      choices,
      actions,
      newId,
      defaultHoursPerDay: settings.hoursPerDay,
    });
    toast(
      trackerId
        ? `Created ${preview.built.project.name} — compare it in Tracking`
        : `Created ${preview.built.project.name}`,
    );
    onClose();
    navigate(`/project/${preview.built.project.id}`);
  }

  return (
    <div>
      <p className="modal-hint">
        <strong>{source.initiativeKey}</strong>{" "}
        {source.snapshot.initiative.summary} ·{" "}
        {preview.built.project.epics.length} epics · {taskCount} issues ·
        snapshot {source.snapshot.fetchedAt.slice(0, 16).replace("T", " ")}.
        Each issue becomes a task sized by its original estimate, whatever its
        status.
      </p>

      <div className="jira-import-fields">
        <div className="field wide">
          <label htmlFor={`${id}-name`}>Project name</label>
          <input
            id={`${id}-name`}
            type="text"
            value={choices.name}
            onChange={(e) => set({ name: e.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-template`}>Copy people from</label>
          <select
            id={`${id}-template`}
            value={choices.templateId ?? ""}
            onChange={(e) => {
              const templateId = e.target.value || null;
              const template = state.projects.find((p) => p.id === templateId);
              set({
                templateId,
                ...(template
                  ? {
                      startDate: template.startDate,
                      buffer: template.buffer ?? 0,
                    }
                  : {}),
              });
            }}
          >
            <option value="">Nobody chosen — every team</option>
            {state.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${id}-start`}>Start date</label>
          <input
            id={`${id}-start`}
            type="date"
            value={choices.startDate}
            onChange={(e) => {
              if (e.target.value) set({ startDate: e.target.value });
            }}
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-buffer`}>Buffer %</label>
          <input
            id={`${id}-buffer`}
            type="number"
            min={0}
            max={100}
            step={5}
            value={choices.buffer}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n)) {
                set({ buffer: Math.min(100, Math.max(0, n)) });
              }
            }}
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-hours`}>Hours per day</label>
          <input
            id={`${id}-hours`}
            type="number"
            min={1}
            max={24}
            step={0.5}
            value={choices.hoursPerDay}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n) && n > 0) set({ hoursPerDay: n });
            }}
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-spec`}>Default specialization</label>
          <input
            id={`${id}-spec`}
            type="text"
            list={`${id}-specs`}
            value={choices.defaultSpecialization}
            onChange={(e) => set({ defaultSpecialization: e.target.value })}
          />
          <datalist id={`${id}-specs`}>
            {specs.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </div>
        <div className="field">
          <label htmlFor={`${id}-track`}>Compare with Jira in</label>
          <select
            id={`${id}-track`}
            value={trackValue}
            onChange={(e) => {
              const v = e.target.value;
              set({
                track: v.startsWith("switch:")
                  ? { kind: "switch", trackerId: v.slice("switch:".length) }
                  : v === "none"
                    ? { kind: "none" }
                    : { kind: "new" },
              });
            }}
          >
            <option value="new">A new tracker</option>
            {sameInitiative.map((t) => (
              <option key={t.id} value={`switch:${t.id}`}>
                {t.name} (switch its baseline)
              </option>
            ))}
            <option value="none">Nowhere — just the project</option>
          </select>
        </div>
      </div>

      <TagAliasEditor
        aliases={choices.tagAliases}
        specializations={teamSpecs}
        unknownTags={preview.built.unknownTags}
        onChange={(tagAliases) => set({ tagAliases })}
      />

      <Comparison preview={preview} />
      <Warnings preview={preview} />
      <IssueList preview={preview} baseUrl={source.baseUrl} />

      <div className="modal-actions">
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="primary"
          onClick={create}
          disabled={taskCount === 0 || !choices.defaultSpecialization.trim()}
        >
          Create project
        </Button>
      </div>
    </div>
  );
}

/** Unknown tags shown before the rest are summarised as "and N more". */
const UNKNOWN_TAGS_SHOWN = 20;

/**
 * Extra words that name a specialization in a Jira label or summary, for tags
 * the teams don't spell the way Jira does ("tooling" for Tools). Targets are
 * picked from the teams, since a task nobody can do can't be scheduled.
 *
 * Tags found on this initiative that name nothing are listed so they can be
 * mapped in one click. Mapping one removes its button, so focus moves to the
 * new row's specialization, which is the one thing left to choose.
 */
function TagAliasEditor({
  aliases,
  specializations,
  unknownTags,
  onChange,
}: {
  aliases: TagAlias[];
  specializations: string[];
  unknownTags: UnknownTag[];
  onChange: (next: TagAlias[]) => void;
}) {
  const id = useId();
  const root = useRef<HTMLFieldSetElement>(null);
  const [focusNext, setFocusNext] = useState<{
    row: number;
    field: "tag" | "spec";
  } | null>(null);
  useEffect(() => {
    if (!focusNext) return;
    root.current
      ?.querySelector<HTMLElement>(
        `[data-row="${focusNext.row}"][data-field="${focusNext.field}"]`,
      )
      ?.focus();
    setFocusNext(null);
  }, [focusNext]);

  const update = (i: number, patch: Partial<TagAlias>) =>
    onChange(aliases.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  const add = (tag: string) => {
    onChange([...aliases, { tag, specialization: specializations[0] ?? "" }]);
    setFocusNext({ row: aliases.length, field: tag ? "spec" : "tag" });
  };
  const shown = unknownTags.slice(0, UNKNOWN_TAGS_SHOWN);
  const hidden = unknownTags.length - shown.length;

  return (
    <fieldset className="jira-import-tags" ref={root}>
      <legend>Tag mappings</legend>
      <p className="muted" id={`${id}-hint`}>
        A Jira label or summary word that names a specialization is used for the
        task. Each team specialization already counts as a tag for itself, and
        "java" counts as Backend unless someone's specialization is Java. Add
        any other tags here.
      </p>
      {aliases.map((alias, i) => {
        // A saved mapping may name a specialization no team has any more.
        const options = specializations.includes(alias.specialization)
          ? specializations
          : [alias.specialization, ...specializations];
        return (
          <div className="jira-import-tag-row" key={i}>
            <input
              type="text"
              aria-label={`Tag ${i + 1}`}
              aria-describedby={`${id}-hint`}
              placeholder="e.g. tools"
              data-row={i}
              data-field="tag"
              value={alias.tag}
              onChange={(e) => update(i, { tag: e.target.value })}
            />
            <span aria-hidden="true">→</span>
            <select
              aria-label={`Specialization for tag ${i + 1}`}
              data-row={i}
              data-field="spec"
              value={alias.specialization}
              onChange={(e) => update(i, { specialization: e.target.value })}
            >
              {options.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <Button
              small
              aria-label={`Remove tag ${i + 1}`}
              onClick={() => onChange(aliases.filter((_, j) => j !== i))}
            >
              Remove
            </Button>
          </div>
        );
      })}
      <Button
        small
        disabled={specializations.length === 0}
        onClick={() => add("")}
      >
        Add tag
      </Button>
      {shown.length > 0 && (
        <div className="jira-import-unknown-tags">
          <p className="muted" id={`${id}-unknown`}>
            Tags on these issues that name no specialization. Map one to use it
            for its tasks:
          </p>
          <ul aria-labelledby={`${id}-unknown`}>
            {shown.map((t) => {
              const n = t.issueKeys.length;
              return (
                <li key={t.tag}>
                  <Button
                    small
                    disabled={specializations.length === 0}
                    aria-label={`Map tag ${t.tag}, on ${n} issue${n === 1 ? "" : "s"}`}
                    title={t.issueKeys.join(", ")}
                    onClick={() => add(t.tag)}
                  >
                    + {t.tag} <span className="muted">· {n}</span>
                  </Button>
                </li>
              );
            })}
          </ul>
          {hidden > 0 && <p className="muted">…and {hidden} more.</p>}
        </div>
      )}
    </fieldset>
  );
}

function Comparison({ preview }: { preview: JiraImportPreview }) {
  const rows: { label: string; side: JiraImportSide }[] = [];
  if (preview.current) {
    rows.push({
      label: `Current plan: ${preview.current.project.name}`,
      side: preview.current,
    });
  }
  rows.push({ label: "Rebuilt from Jira", side: preview.rebuilt });

  return (
    <div className="table-scroll">
      <table className="epics-table jira-import-compare">
        <caption className="sr-only">Plan comparison</caption>
        <thead>
          <tr>
            <th scope="col">Plan</th>
            <th scope="col">Estimate</th>
            <th scope="col">Finish, no buffer</th>
            <th scope="col">Promised finish</th>
            <th scope="col">Today</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ label, side }) => {
            const status = statusLabel(side.status);
            return (
              <tr key={label}>
                <th scope="row">{label}</th>
                <td className="num">{days(side.estimateDays)} d</td>
                <td>{side.plans.unbufferedEnd ?? "—"}</td>
                <td>{side.plans.bufferedEnd ?? "—"}</td>
                <td className={"status-cell " + status.tone}>
                  <span aria-hidden="true">{status.glyph} </span>
                  {status.text}
                  {side.status.kind !== "no-baseline" &&
                    side.status.projectedFinish && (
                      <span className="muted">
                        {" "}
                        · on pace for {side.status.projectedFinish}
                      </span>
                    )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Warnings({ preview }: { preview: JiraImportPreview }) {
  const { specSources, unestimated, missingSpecializations, rebuilt } = preview;
  const parts = (Object.keys(specSources) as SpecializationSource[])
    .filter((k) => specSources[k] > 0)
    .map((k) => `${specSources[k]} ${SOURCE_WORDS[k]}`);
  return (
    <div className="jira-import-notes">
      {parts.length > 0 && (
        <p className="muted">Specializations: {parts.join(" · ")}.</p>
      )}
      {unestimated > 0 && (
        <p className="warn-box">
          {unestimated} issue{unestimated === 1 ? " has" : "s have"} no estimate
          in Jira.{" "}
          {unestimated === 1
            ? "It is added as a skipped task with 0 days. Set an estimate on the project page to plan it."
            : "They are added as skipped tasks with 0 days. Set estimates on the project page to plan them."}
        </p>
      )}
      {missingSpecializations.length > 0 && (
        <p className="warn-box">
          Nobody on the included teams has{" "}
          {missingSpecializations.map((s) => `"${s}"`).join(", ")}, so{" "}
          {rebuilt.unassigned} task{rebuilt.unassigned === 1 ? "" : "s"} can't
          be scheduled. Change the default specialization, or fix these tasks
          after creating the project.
        </p>
      )}
      {missingSpecializations.length === 0 && rebuilt.unassigned > 0 && (
        <p className="warn-box">
          {rebuilt.unassigned} task{rebuilt.unassigned === 1 ? "" : "s"} can't
          be scheduled with the people available. The project page lists why.
        </p>
      )}
      {preview.built.emptyEpics.length > 0 && (
        <p className="muted">
          Epics with no issues, left out: {preview.built.emptyEpics.join(", ")}.
        </p>
      )}
    </div>
  );
}

function IssueList({
  preview,
  baseUrl,
}: {
  preview: JiraImportPreview;
  baseUrl: string;
}) {
  const info = new Map(preview.built.tasks.map((t) => [t.taskId, t]));
  return (
    <details className="jira-import-issues">
      <summary>Epics and tasks to be created</summary>
      {preview.built.project.epics.map((epic) => {
        const total = epic.tasks.reduce(
          (n, t) => n + (t.excluded ? 0 : t.estimateDays),
          0,
        );
        return (
          <div key={epic.id} className="jira-import-epic">
            <h4>
              {epic.name}{" "}
              <span className="muted">
                · {epic.tasks.length} task{epic.tasks.length === 1 ? "" : "s"} ·{" "}
                {days(total)} d
              </span>
            </h4>
            <table className="epics-table">
              <thead>
                <tr>
                  <th scope="col">Key</th>
                  <th scope="col">Task</th>
                  <th scope="col">Days</th>
                  <th scope="col">Specialization</th>
                </tr>
              </thead>
              <tbody>
                {epic.tasks.map((task) => {
                  const row = info.get(task.id);
                  return (
                    <tr
                      key={task.id}
                      className={task.excluded ? "excluded" : ""}
                    >
                      <td>
                        {row && (
                          <a
                            href={`${baseUrl}/browse/${row.issueKey}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {row.issueKey}
                          </a>
                        )}
                      </td>
                      <td>{task.name}</td>
                      <td className="num">
                        {task.excluded
                          ? "no estimate"
                          : days(task.estimateDays)}
                      </td>
                      <td>
                        {task.specialization}
                        {row && (
                          <span className="muted">
                            {" "}
                            ({SOURCE_WORDS[row.specializationSource]})
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })}
    </details>
  );
}
