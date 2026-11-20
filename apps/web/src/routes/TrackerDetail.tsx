import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  awaitingCloseWhatIf,
  jiraTaskTeams,
  pastInProgressAsDone,
  selectedTeams,
  trackerTeams,
  trackedMapping,
  trackerSpecializations,
  baselinePlans,
  todayISO,
  trackerStatus,
} from "@planner/core";
import { estimateUpdates, secondsToDays, trackerMapping } from "@planner/jira";
import { useAppStore } from "@planner/client-runtime";
import {
  Button,
  Callout,
  EmptyState,
  Icon,
  IconTile,
  Page,
  PageHeader,
  ViewTabs,
  Panel,
} from "../components/ui";
import { useConfirm } from "../components/ui/ConfirmDialog";
import { useToast } from "../components/ui/Toast";
import { DeadlinesPanel } from "../components/tracking/DeadlinesPanel";
import { EstimateUpdateModal } from "../components/tracking/EstimateUpdateModal";
import { HistoryPanel } from "../components/tracking/HistoryPanel";
import { JiraImportModal } from "../components/tracking/JiraImportModal";
import { JiraSettingsPanel } from "../components/tracking/JiraSettingsPanel";
import { RemainingWorkPanel } from "../components/tracking/RemainingWorkPanel";
import { SprintPlanner } from "../components/tracking/SprintPlanner";
import { SprintSection } from "../components/tracking/SprintSection";
import { AutoSprintPlanner } from "../components/tracking/AutoSprintPlanner";
import { StatusPanel, days } from "../components/tracking/StatusPanel";
import { TeamSelector } from "../components/tracking/TeamSelector";
import { TasksTable } from "../components/tracking/TasksTable";
import { useTrackerRefresh } from "../components/tracking/useTrackerRefresh";
import { isJiraConfigured } from "../lib/jiraSettings";
import { STALE_AFTER_DAYS, snapshotAgeDays } from "../lib/refreshTracker";
import { DEFAULT_HOURS_PER_DAY } from "../lib/jiraSettings";
import { readTagAliases } from "../lib/tagAliases";
import { TRACKER_VIEWS, useView } from "../lib/views";
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
  const [view, setView] = useView(TRACKER_VIEWS);

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

  // A view of the status, not a setting: tasks past In Progress (review,
  // QA, ready to deploy) read as done. Refresh samples never use it.
  const [countPastInProgress, setCountPastInProgress] = useState(false);
  const pastInProgress = useMemo(
    () => (tracker ? pastInProgressAsDone(tracker) : null),
    [tracker],
  );
  const readTracker =
    countPastInProgress && pastInProgress ? pastInProgress.tracker : tracker;

  const status = useMemo(
    () =>
      readTracker
        ? trackerStatus(readTracker, project, state.teams, today)
        : undefined,
    [readTracker, project, state.teams, today],
  );

  // The project's teams, and which Jira task is whose, for reading one team
  // apart from another (or several merged).
  const projectTeams = useMemo(
    () =>
      tracker && project ? trackerTeams(tracker, project, state.teams) : [],
    [tracker, project, state.teams],
  );
  // The teams the reading is limited to; the task table shows only theirs.
  const shownTeams = useMemo(
    () =>
      tracker && project ? selectedTeams(tracker, project, state.teams) : null,
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
      readTracker
        ? awaitingCloseWhatIf(readTracker, project, state.teams, today)
        : null,
    [readTracker, project, state.teams, today],
  );

  const planCheck = useMemo(() => {
    if (!project) return null;
    const base = baselinePlans(project, state.teams);
    return base.stale
      ? { storedEnd: base.storedEnd, currentEnd: base.bufferedEnd }
      : null;
  }, [project, state.teams]);

  // Name matches plus new work sorted by its tags, exactly as a refresh
  // does it (see `trackerMapping`). The tag vocabulary is this device's.
  const mapping = useMemo(
    () =>
      tracker?.snapshot && project
        ? trackerMapping({
            project,
            teams: state.teams,
            snapshot: tracker.snapshot,
            tracker,
            tagAliases: readTagAliases(),
          })
        : null,
    [tracker, project, state.teams],
  );
  const effectiveTaskMap = useMemo(
    () => mapping?.taskMap ?? tracker?.taskMap ?? {},
    [mapping, tracker?.taskMap],
  );
  const effectiveAddedScope = mapping?.addedScope ?? tracker?.addedScope;

  // Everyone who could do added scope.
  const specializations = useMemo(
    () => (project ? trackerSpecializations(project, state.teams) : []),
    [project, state.teams],
  );

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

  // Persist deterministic guesses so they sync to other devices and future
  // refresh samples use the exact mapping visible in this table.
  useEffect(() => {
    if (!tracker || !mapping) return;
    if (!sameMap(mapping.taskMap, tracker.taskMap ?? {})) {
      actions.setTrackerTaskMap(tracker.id, mapping.taskMap);
    }
    if (!sameMap(mapping.addedScope, tracker.addedScope ?? {})) {
      actions.setTrackerAddedScope(tracker.id, mapping.addedScope);
    }
  }, [tracker, mapping, actions]);

  if (!tracker) {
    return (
      <Page className="tracker-page">
        <PageHeader
          eyebrow={<Link to="/tracking">Tracking</Link>}
          title="Tracker not found"
        />
        <EmptyState
          title="That tracker doesn't exist"
          message="It may have been deleted. Pick another from Tracking."
        />
      </Page>
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

  // Each view that needs Jira's data says so the same way until there is some.
  const noSnapshot = (
    <EmptyState
      title="No snapshot yet"
      message={
        connected
          ? "Press Refresh to pull this initiative's epics and time tracking from Jira."
          : "Connect Jira, then press Refresh to pull this initiative's epics and time tracking."
      }
    />
  );
  const noBaseline = (
    <Callout tone="info" title="No baseline plan">
      {state.projects.length === 0
        ? "Create a project first, then link it here."
        : "Pick a baseline plan above to compare Jira with what you planned."}
    </Callout>
  );

  const issuesDone = snapshot
    ? snapshot.epics.reduce((n, e) => n + e.totals.done, 0)
    : 0;
  const issuesAll = snapshot
    ? snapshot.epics.reduce((n, e) => n + e.totals.all, 0)
    : 0;

  return (
    <Page className="tracker-page" width="wide">
      <PageHeader
        eyebrow={
          <nav aria-label="Breadcrumb" className="tracker-crumbs">
            <Link to="/tracking">Tracking</Link>
            <Icon name="chevronRight" size={12} />
            <span aria-current="page">{tracker.name}</span>
          </nav>
        }
        leading={<IconTile icon="target" size="lg" />}
        title={
          <input
            className="page-title-input"
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
        }
        subtitle={
          <>
            <a
              className="jira-link"
              href={
                tracker.initiativeUrl ||
                `${tracker.baseUrl}/browse/${tracker.initiativeKey}`
              }
              target="_blank"
              rel="noreferrer"
            >
              <Icon name="jira" size={13} />
              {tracker.initiativeKey} in Jira ↗
            </a>
            <span aria-hidden="true">·</span>
            <span className={"snapshot-age" + (stale ? " stale" : "")}>
              {snapshot
                ? `Snapshot ${snapshot.fetchedAt.slice(0, 16).replace("T", " ")}`
                : "Never refreshed"}
              {stale && " · out of date"}
            </span>
          </>
        }
        actions={
          <>
            <Button
              variant="primary"
              icon="refresh"
              onClick={() => void refresh(tracker)}
              disabled={busy || !connected}
            >
              {busy ? "Refreshing…" : "Refresh"}
            </Button>
            <Button
              icon="layers"
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
            <Button
              variant="ghost"
              icon="settings"
              onClick={() => setSettingsOpen(true)}
            >
              Jira settings
            </Button>
            <Button variant="danger" icon="trash" onClick={remove}>
              Delete
            </Button>
          </>
        }
      >
        <div className="tracker-toolbar">
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
          {status && projectTeams.length > 1 && (
            <TeamSelector
              teams={projectTeams}
              selected={tracker.viewTeams}
              onChange={(names) =>
                actions.setTrackerViewTeams(tracker.id, names)
              }
            />
          )}
        </div>
        <ViewTabs
          base={`/tracking/${tracker.id}`}
          views={TRACKER_VIEWS}
          current={view}
          label="Tracker views"
        />
      </PageHeader>

      {!connected && (
        <Callout
          tone="warning"
          actions={
            <Button small onClick={() => setSettingsOpen(true)}>
              Connect Jira
            </Button>
          }
        >
          Connect Jira before refreshing — Planner needs your Atlassian email
          and an API token.
        </Callout>
      )}

      {view === "overview" && (
        <>
          {snapshot && (
            <Panel
              tone="muted"
              className="initiative-summary"
              aria-label="Initiative"
              icon={<Icon name="jira" size={17} />}
              title={snapshot.initiative.summary}
              subtitle={
                <>
                  {snapshot.initiative.status}
                  {snapshot.initiative.dueDate
                    ? ` · due ${snapshot.initiative.dueDate}`
                    : ""}
                  {" · "}
                  {snapshot.epics.length} epic
                  {snapshot.epics.length === 1 ? "" : "s"}
                  {" · "}
                  {issuesDone}/{issuesAll} issues done
                  {" · "}
                  {days(
                    secondsToDays(
                      snapshot.epics.reduce(
                        (n, e) => n + e.totals.remainingSec,
                        0,
                      ),
                      hoursPerDay,
                    ),
                  )}{" "}
                  days remaining
                </>
              }
              actions={
                <Button small variant="ghost" onClick={() => setView("issues")}>
                  View issues
                </Button>
              }
            />
          )}

          {status && (
            <StatusPanel
              status={status}
              awaitingClose={awaitingClose}
              pastInProgress={
                (pastInProgress?.tasks ?? 0) > 0
                  ? {
                      checked: countPastInProgress,
                      onChange: setCountPastInProgress,
                    }
                  : undefined
              }
              planStale={
                planCheck && status.kind !== "no-baseline"
                  ? planCheck
                  : undefined
              }
              onOpenProject={
                project ? () => navigate(`/project/${project.id}`) : undefined
              }
            >
              {state.projects.length === 0 ? (
                <p className="muted">
                  Create a project first, then link it here.
                </p>
              ) : (
                <p className="muted">
                  Pick a baseline plan above to compare Jira with what you
                  planned.
                </p>
              )}
            </StatusPanel>
          )}

          {project && snapshot && (
            <DeadlinesPanel
              project={project}
              deadlines={tracker.deadlines}
              resolved={status?.deadlines ?? null}
              measured={[
                ...(status?.bySpecialization ?? []).map(
                  (r) => r.specialization,
                ),
                ...specializations,
              ]}
              onChange={(next) => actions.setTrackerDeadlines(tracker.id, next)}
            />
          )}

          {!snapshot && connected && (
            <p className="muted">
              Press Refresh to pull this initiative's epics and time tracking
              from Jira.
            </p>
          )}
        </>
      )}

      {view === "issues" &&
        (!snapshot ? (
          noSnapshot
        ) : !project ? (
          noBaseline
        ) : (
          <>
            {updates.length > 0 && (
              <Callout
                tone="info"
                role="status"
                actions={
                  <Button small onClick={() => setEstimatesOpen(true)}>
                    Review estimates…
                  </Button>
                }
              >
                {updates.length === 1
                  ? "1 plan task has a different estimate in Jira."
                  : `${updates.length} plan tasks have a different estimate in Jira.`}
              </Callout>
            )}
            <TasksTable
              snapshot={snapshot}
              baseUrl={tracker.baseUrl}
              project={project}
              taskMap={effectiveTaskMap}
              hoursPerDay={hoursPerDay}
              onReviewEstimates={() => setEstimatesOpen(true)}
              addedScope={effectiveAddedScope}
              untrackedEpics={tracker.untrackedEpics}
              niceToHaveEpics={tracker.niceToHaveEpics}
              onSetEpicTracking={(epicKey, tracking) =>
                actions.setTrackerEpicTracking(tracker.id, epicKey, tracking)
              }
              specializations={specializations}
              teams={projectTeams}
              taskTeams={taskTeams}
              shownTeams={shownTeams}
              onSetTaskTeam={(key, team) =>
                actions.setTrackerTaskTeam(tracker.id, key, team)
              }
              onSetAddedScope={(key, specialization) => {
                // Not a plan task, so name matching must never claim it.
                actions.setTrackerTaskMap(tracker.id, {
                  ...effectiveTaskMap,
                  [key]: null,
                });
                actions.setTrackerAddedScope(tracker.id, {
                  ...(effectiveAddedScope ?? {}),
                  [key]: specialization,
                });
              }}
            />
          </>
        ))}

      {view === "forecast" &&
        (!snapshot ? (
          noSnapshot
        ) : !project ? (
          noBaseline
        ) : (
          <RemainingWorkPanel
            tracker={tracker}
            project={project}
            teams={state.teams}
            today={today}
            status={status}
          />
        ))}

      {view === "sprints" &&
        (!snapshot ? (
          noSnapshot
        ) : (
          <SprintSection
            auto={
              project && (
                <AutoSprintPlanner
                  tracker={tracker}
                  project={project}
                  teams={state.teams}
                  today={today}
                />
              )
            }
          >
            <SprintPlanner
              tracker={tracker}
              snapshot={snapshot}
              project={project}
              teams={state.teams}
              hoursPerDay={hoursPerDay}
              onChange={(draft) =>
                actions.setTrackerSprintDraft(tracker.id, draft)
              }
              onApplied={(applied) =>
                actions.markSprintItemsApplied(tracker.id, applied)
              }
            />
          </SprintSection>
        ))}

      {view === "history" &&
        (tracker.samples && tracker.samples.length > 0 ? (
          <HistoryPanel samples={tracker.samples} />
        ) : (
          <EmptyState
            title="No history yet"
            message="Every refresh adds a reading here, so you can see whether the buffer is going faster this week than last."
          />
        ))}

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
    </Page>
  );
}

/** Same keys, same values. */
function sameMap<T>(a: { [key: string]: T }, b: { [key: string]: T }): boolean {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every(
      (k) => Object.prototype.hasOwnProperty.call(b, k) && a[k] === b[k],
    )
  );
}
