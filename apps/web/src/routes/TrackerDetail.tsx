import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  autoTaskMap,
  awaitingCloseWhatIf,
  jiraTaskTeams,
  trackerTeams,
  includedMembers,
  trackedMapping,
  untrackedIssueKeys,
  baselinePlans,
  todayISO,
  trackerStatus,
} from "@planner/core";
import { estimateUpdates, secondsToDays } from "@planner/jira";
import { useAppStore } from "@planner/client-runtime";
import { Button } from "../components/ui/Button";
import { useConfirm } from "../components/ui/ConfirmDialog";
import { useToast } from "../components/ui/Toast";
import { DeadlinesPanel } from "../components/tracking/DeadlinesPanel";
import { EpicsTable } from "../components/tracking/EpicsTable";
import { EstimateUpdateModal } from "../components/tracking/EstimateUpdateModal";
import { HistoryPanel } from "../components/tracking/HistoryPanel";
import { JiraImportModal } from "../components/tracking/JiraImportModal";
import { JiraSettingsPanel } from "../components/tracking/JiraSettingsPanel";
import { RemainingWorkPanel } from "../components/tracking/RemainingWorkPanel";
import { SprintPlanner } from "../components/tracking/SprintPlanner";
import { StatusPanel, days } from "../components/tracking/StatusPanel";
import { TeamSelector } from "../components/tracking/TeamSelector";
import { TasksTable } from "../components/tracking/TasksTable";
import { useTrackerRefresh } from "../components/tracking/useTrackerRefresh";
import { isJiraConfigured } from "../lib/jiraSettings";
import { STALE_AFTER_DAYS, snapshotAgeDays } from "../lib/refreshTracker";
import { DEFAULT_HOURS_PER_DAY } from "../lib/jiraSettings";
import "../components/tracking/tracking.css";

export function TrackerDetail() {
  const { id } = useParams();
  const { state, actions } = useAppStore();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { refresh, busyIds, transport, settings } = useTrackerRefresh();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [estimatesOpen, setEstimatesOpen] = useState(false);
  const toast = useToast();

  const tracker = (state.trackers ?? []).find((t) => t.id === id);
  const [name, setName] = useState(tracker?.name ?? "");
  useEffect(() => {
    if (tracker) setName(tracker.name);
  }, [tracker?.name, tracker]);

  const project = tracker?.projectId
    ? state.projects.find((p) => p.id === tracker.projectId)
    : undefined;

  const today = todayISO();
  const now = new Date().toISOString();

  const status = useMemo(
    () =>
      tracker ? trackerStatus(tracker, project, state.teams, today) : undefined,
    [tracker, project, state.teams, today],
  );

  // The project's teams, and which Jira task is whose, for reading one team
  // apart from another (or several merged).
  const projectTeams = useMemo(
    () =>
      tracker && project ? trackerTeams(tracker, project, state.teams) : [],
    [tracker, project, state.teams],
  );
  const taskTeams = useMemo(
    () =>
      tracker?.snapshot && project
        ? jiraTaskTeams(
            tracker.snapshot,
            project,
            state.teams,
            tracker.taskTeams,
          )
        : undefined,
    [tracker, project, state.teams],
  );

  const awaitingClose = useMemo(
    () =>
      tracker
        ? awaitingCloseWhatIf(tracker, project, state.teams, today)
        : null,
    [tracker, project, state.teams, today],
  );

  const planCheck = useMemo(() => {
    if (!project) return null;
    const base = baselinePlans(project, state.teams);
    return base.stale
      ? { storedEnd: base.storedEnd, currentEnd: base.bufferedEnd }
      : null;
  }, [project, state.teams]);

  const effectiveTaskMap = useMemo(
    () =>
      tracker?.snapshot && project
        ? autoTaskMap(
            project,
            tracker.snapshot,
            tracker.taskMap,
            // Another team's issues are never name-matched onto plan tasks.
            untrackedIssueKeys(tracker.snapshot, tracker.untrackedEpics),
          )
        : (tracker?.taskMap ?? {}),
    [tracker, project],
  );

  // Everyone who could do added scope: the plan's own specializations first,
  // then those of the people on the project who have no task yet.
  const specializations = useMemo(() => {
    if (!project) return [];
    const out: string[] = [];
    const add = (spec: string | undefined) => {
      const s = (spec ?? "").trim();
      if (s && !out.some((o) => o.toLowerCase() === s.toLowerCase())) {
        out.push(s);
      }
    };
    for (const epic of project.epics) {
      for (const task of epic.tasks) add(task.specialization);
    }
    for (const m of includedMembers(project, state.teams)) {
      add(m.specialization);
    }
    for (const h of project.helpers ?? []) add(h.specialization);
    return out;
  }, [project, state.teams]);

  // Refresh leaves the baseline alone; differences are offered, not applied.
  const updates = useMemo(
    () =>
      tracker?.snapshot && project
        ? estimateUpdates(
            project,
            tracker.snapshot,
            trackedMapping({ ...tracker, taskMap: effectiveTaskMap }).taskMap,
            tracker.hoursPerDay ?? DEFAULT_HOURS_PER_DAY,
          )
        : [],
    [tracker, project, effectiveTaskMap],
  );

  // Persist deterministic guesses so manual corrections sync to other devices
  // and future refresh samples use the exact mapping visible in this table.
  useEffect(() => {
    if (!tracker?.snapshot || !project) return;
    const next = effectiveTaskMap;
    const current = tracker.taskMap ?? {};
    const changed =
      Object.keys(next).length !== Object.keys(current).length ||
      Object.keys(next).some((k) => next[k] !== current[k]);
    if (changed) actions.setTrackerTaskMap(tracker.id, next);
  }, [tracker, project, effectiveTaskMap, actions]);

  if (!tracker) {
    return (
      <main className="page">
        <div className="detail-topbar">
          <Link to="/tracking" className="back-link">
            ← Tracking
          </Link>
        </div>
        <p className="muted">
          That tracker doesn't exist (it may have been deleted).
        </p>
      </main>
    );
  }

  const hoursPerDay = tracker.hoursPerDay ?? DEFAULT_HOURS_PER_DAY;
  const snapshot = tracker.snapshot;
  const age = snapshotAgeDays(tracker, now);
  const stale = age !== null && age >= STALE_AFTER_DAYS;
  const busy = busyIds.has(tracker.id);
  const connected = isJiraConfigured(settings);

  const commitName = () => {
    const next = name.trim();
    if (next && next !== tracker.name) actions.renameTracker(tracker.id, next);
    else if (!next) setName(tracker.name);
  };

  async function remove() {
    if (!tracker) return;
    const ok = await confirm({
      title: "Delete tracker",
      message: `Stop tracking ${tracker.initiativeKey}? Its refresh history is deleted too.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (ok) {
      actions.deleteTracker(tracker.id);
      navigate("/tracking");
    }
  }

  return (
    <main className="page">
      <div className="detail-topbar">
        <Link to="/tracking" className="back-link">
          ← Tracking
        </Link>
      </div>

      <div className="tracker-header">
        <input
          className="tracker-name-input"
          aria-label="Tracker name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.blur();
            }
          }}
        />
        <a
          className="jira-link"
          href={
            tracker.initiativeUrl ||
            `${tracker.baseUrl}/browse/${tracker.initiativeKey}`
          }
          target="_blank"
          rel="noreferrer"
        >
          {tracker.initiativeKey} in Jira ↗
        </a>
      </div>

      <div className="tracker-toolbar">
        <Button
          variant="primary"
          onClick={() => void refresh(tracker)}
          disabled={busy || !connected}
        >
          {busy ? "Refreshing…" : "Refresh"}
        </Button>
        <span className={"muted" + (stale ? " stale" : "")}>
          {snapshot
            ? `Snapshot ${snapshot.fetchedAt.slice(0, 16).replace("T", " ")}`
            : "Never refreshed"}
          {stale && " · out of date"}
        </span>

        <label className="baseline-picker">
          <span>Baseline plan</span>
          <select
            value={tracker.projectId ?? ""}
            onChange={(e) =>
              actions.setTrackerProject(tracker.id, e.target.value || null)
            }
          >
            <option value="">None</option>
            {state.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>

        <Button
          onClick={() => setImportOpen(true)}
          disabled={!snapshot}
          title={
            snapshot
              ? "Build a fresh project from this initiative's issues and estimates"
              : "Refresh first — the plan is built from the last snapshot"
          }
        >
          New plan from Jira
        </Button>

        <span className="spacer" />
        <button
          type="button"
          className="link-btn"
          onClick={() => setSettingsOpen(true)}
        >
          Jira settings
        </button>
        <Button variant="danger" small onClick={remove}>
          Delete
        </Button>
      </div>

      {!connected && (
        <div className="warn-box">
          Connect Jira before refreshing — Planner needs your Atlassian email
          and an API token.{" "}
          <button
            type="button"
            className="link-btn"
            onClick={() => setSettingsOpen(true)}
          >
            Connect Jira
          </button>
        </div>
      )}

      {snapshot && (
        <section className="initiative-summary" aria-label="Initiative">
          <h2 className="section-title">{snapshot.initiative.summary}</h2>
          <p className="muted">
            {snapshot.initiative.status}
            {snapshot.initiative.dueDate
              ? ` · due ${snapshot.initiative.dueDate}`
              : ""}
            {" · "}
            {snapshot.epics.length} epic
            {snapshot.epics.length === 1 ? "" : "s"}
            {" · "}
            {snapshot.epics.reduce((n, e) => n + e.totals.done, 0)}/
            {snapshot.epics.reduce((n, e) => n + e.totals.all, 0)} issues done
            {" · "}
            {days(
              secondsToDays(
                snapshot.epics.reduce((n, e) => n + e.totals.remainingSec, 0),
                hoursPerDay,
              ),
            )}{" "}
            days remaining
          </p>
        </section>
      )}

      {project && snapshot && (
        <DeadlinesPanel
          project={project}
          deadlines={tracker.deadlines}
          resolved={status?.deadlines ?? null}
          onChange={(next) => actions.setTrackerDeadlines(tracker.id, next)}
        />
      )}

      {status && projectTeams.length > 1 && (
        <TeamSelector
          teams={projectTeams}
          selected={tracker.viewTeams}
          onChange={(names) => actions.setTrackerViewTeams(tracker.id, names)}
        />
      )}

      {status && (
        <StatusPanel
          status={status}
          awaitingClose={awaitingClose}
          planStale={
            planCheck && status.kind !== "no-baseline" ? planCheck : undefined
          }
          onOpenProject={
            project ? () => navigate(`/project/${project.id}`) : undefined
          }
        >
          {state.projects.length === 0 ? (
            <p className="muted">Create a project first, then link it here.</p>
          ) : (
            <p className="muted">
              Pick a baseline plan above to compare Jira with what you planned.
            </p>
          )}
        </StatusPanel>
      )}

      {snapshot && project && updates.length > 0 && (
        <div className="estimate-updates" role="status">
          <span>
            {updates.length === 1
              ? "1 plan task has a different estimate in Jira."
              : `${updates.length} plan tasks have a different estimate in Jira.`}
          </span>
          <Button small onClick={() => setEstimatesOpen(true)}>
            Review estimates…
          </Button>
        </div>
      )}

      {snapshot && project && (
        <TasksTable
          snapshot={snapshot}
          baseUrl={tracker.baseUrl}
          project={project}
          taskMap={effectiveTaskMap}
          hoursPerDay={hoursPerDay}
          onReviewEstimates={() => setEstimatesOpen(true)}
          onMapTask={(key, plannerTaskId) =>
            actions.setTrackerTaskMap(tracker.id, {
              ...effectiveTaskMap,
              [key]: plannerTaskId,
            })
          }
          addedScope={tracker.addedScope}
          untrackedEpics={tracker.untrackedEpics}
          onSetEpicTracked={(epicKey, tracked) => {
            const current = tracker.untrackedEpics ?? [];
            actions.setTrackerUntrackedEpics(
              tracker.id,
              tracked
                ? current.filter((k) => k !== epicKey)
                : [...current, epicKey],
            );
          }}
          specializations={specializations}
          teams={projectTeams}
          taskTeams={taskTeams}
          onSetTaskTeam={(key, team) =>
            actions.setTrackerTaskTeam(tracker.id, key, team)
          }
          onSetAddedScope={(key, specialization) => {
            const next = { ...(tracker.addedScope ?? {}) };
            if (specialization) {
              next[key] = specialization;
              // Not a plan task, so name matching must never claim it.
              actions.setTrackerTaskMap(tracker.id, {
                ...effectiveTaskMap,
                [key]: null,
              });
            } else {
              delete next[key];
            }
            actions.setTrackerAddedScope(tracker.id, next);
          }}
        />
      )}

      {snapshot && (
        <EpicsTable
          snapshot={snapshot}
          baseUrl={tracker.baseUrl}
          hoursPerDay={hoursPerDay}
          epicMap={undefined}
        />
      )}

      {tracker.samples && tracker.samples.length > 0 && (
        <HistoryPanel samples={tracker.samples} />
      )}

      {snapshot && (
        <SprintPlanner
          tracker={tracker}
          snapshot={snapshot}
          project={project}
          teams={state.teams}
          hoursPerDay={hoursPerDay}
          onChange={(draft) => actions.setTrackerSprintDraft(tracker.id, draft)}
          onApplied={(applied) =>
            actions.markSprintItemsApplied(tracker.id, applied)
          }
        />
      )}

      {snapshot && project && (
        <RemainingWorkPanel
          tracker={tracker}
          project={project}
          teams={state.teams}
          today={today}
          status={status}
        />
      )}

      {!snapshot && connected && (
        <p className="muted">
          Press Refresh to pull this initiative's epics and time tracking from
          Jira.
        </p>
      )}

      {project && (
        <EstimateUpdateModal
          open={estimatesOpen}
          onClose={() => setEstimatesOpen(false)}
          projectName={project.name}
          updates={updates}
          onApply={(chosen) => {
            for (const u of chosen) {
              actions.editTask(project.id, u.epicId, u.taskId, {
                estimateDays: u.jiraDays,
                excluded: false,
              });
            }
            setEstimatesOpen(false);
            toast(
              `Updated ${chosen.length} estimate${chosen.length === 1 ? "" : "s"} in ${project.name}`,
            );
          }}
        />
      )}

      <JiraImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        tracker={tracker}
      />

      <JiraSettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        transport={transport}
      />
    </main>
  );
}
