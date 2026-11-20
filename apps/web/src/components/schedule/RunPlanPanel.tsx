import { useMemo, useState } from "react";
import {
  type Assignment,
  type PlanViewMode,
  type Project,
  planViewModeOf,
  runPlan,
  allMembers,
  mergedOffDays,
  buildPlanWorkbook,
  planFilenameStem,
  visiblePlanMarkers,
} from "@planner/core";
import { useAppStore } from "@planner/client-runtime";
import { downloadPlanExcel } from "../../lib/download";
import { downloadTimelinePng } from "../../lib/planImage";
import {
  isGoogleConfigured,
  pushWorkbookToGoogleSheets,
} from "../../lib/googleSheets";
import { Button } from "../ui/Button";
import { Callout } from "../ui/Callout";
import { EmptyState } from "../ui/EmptyState";
import { Icon } from "../ui/Icon";
import { Panel } from "../ui/Panel";
import { Segmented } from "../ui/Segmented";
import { useToast } from "../ui/Toast";
import { computeGanttRange, formatLongDate } from "./DateGrid";
import { GanttByPerson } from "./GanttByPerson";
import { GanttByTask } from "./GanttByTask";
import { GanttByEpic } from "./GanttByEpic";
import { OverviewTimeline } from "./OverviewTimeline";
import { AssignmentsTable } from "./AssignmentsTable";
import { TeamBreakdown } from "./TeamBreakdown";
import { UnassignedCallout } from "./UnassignedCallout";
import { PlanMarkersEditor } from "./PlanMarkersEditor";
import "./schedule.css";

interface RunPlanPanelProps {
  project: Project;
}

type PlanMode = "balanced" | "smart";

const VIEW_HINTS: Record<PlanViewMode, string> = {
  person: "by person",
  task: "by task",
  epic: "by epic",
};

/** True when the assignment's task or epic name contains the query. */
function matchesQuery(a: Assignment, q: string): boolean {
  return (
    a.taskName.toLowerCase().includes(q) || a.epicName.toLowerCase().includes(q)
  );
}

/** Trim a day count to at most one decimal, dropping a trailing ".0". */
function formatDays(n: number): string {
  return Number(n.toFixed(1)).toString();
}

/**
 * The plan view of a project: a settings card (planning mode, look-ahead,
 * estimate buffer, the Run plan button and what the last run concluded), the
 * timeline markers beside it, and the run's results below.
 */
export function RunPlanPanel({ project }: RunPlanPanelProps) {
  const { state, actions } = useAppStore();
  const plan = project.plan;
  const mode: PlanMode = project.planMode === "smart" ? "smart" : "balanced";
  const lookahead = project.planLookahead ?? 5;
  const buffer = project.buffer ?? 0;

  const handleRun = () => {
    actions.setPlan(
      project.id,
      runPlan(project, state.teams, undefined, { mode, lookahead }),
    );
  };

  return (
    <div className="run-plan-panel">
      <div className="run-plan-top">
        <Panel
          className="run-plan-settings"
          icon={<Icon name="sliders" size={17} />}
          title="Run plan"
          subtitle="How the scheduler assigns the included tasks."
        >
          <div className="rp-field">
            <div className="rp-field-head">
              <span className="rp-label">Planning mode</span>
            </div>
            <Segmented<PlanMode>
              label="Planning mode"
              className="rp-mode"
              value={mode}
              onChange={(m) => actions.setPlanMode(project.id, m)}
              options={[
                { value: "balanced", label: "Balanced" },
                {
                  value: "smart",
                  label: "Smart",
                  ariaLabel: "Smart (days-off aware)",
                },
              ]}
            />
            <p className="rp-hint">
              {mode === "smart" ? (
                <>
                  <strong>Smart (days-off aware).</strong> Instead of taking
                  tasks strictly top → bottom, whoever is free earliest picks
                  the best-fitting task among the next {lookahead} in line,
                  preferring work that finishes before their own next break, so
                  a long task isn't handed to someone about to take time off
                  when a colleague could take it instead. Weekends, days off,
                  and dependencies are all respected.
                </>
              ) : (
                <>
                  <strong>Balanced.</strong> Tasks are scheduled in their
                  priority order under Epics &amp; tasks (top → bottom). Each
                  included task goes to the matching-specialization member who
                  can start it soonest, accounting for weekends and each
                  person's marked days off. Skipped tasks are ignored.
                </>
              )}
            </p>
          </div>

          {mode === "smart" && (
            <label className="rp-field">
              <span className="rp-field-head">
                <span className="rp-label">Look-ahead</span>
                <span className="rp-value">
                  {lookahead} task{lookahead === 1 ? "" : "s"}
                </span>
              </span>
              <input
                type="range"
                min={1}
                max={15}
                step={1}
                value={lookahead}
                onChange={(e) =>
                  actions.setPlanMode(
                    project.id,
                    "smart",
                    Number(e.target.value),
                  )
                }
                aria-label="Lookahead window size"
              />
              <span className="rp-hint">
                Smaller = stick closer to your priority order; larger = more
                freedom to optimize around days off.
              </span>
            </label>
          )}

          <label className="rp-field">
            <span className="rp-field-head">
              <span className="rp-label">Estimate buffer</span>
              <span className="rp-value">{buffer}%</span>
            </span>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={buffer}
              onChange={(e) =>
                actions.setProjectBuffer(project.id, Number(e.target.value))
              }
              aria-label="Estimate buffer percentage"
            />
            <span className="rp-hint">
              Pads every task's estimate before scheduling, to allow for
              uncertainty without editing individual tasks.
              {buffer > 0 && (
                <>
                  {" "}
                  A 5-day task plans as {(5 * (1 + buffer / 100)).toFixed(1)}d.
                </>
              )}
            </span>
          </label>

          <div className="rp-run">
            <Button
              variant="primary"
              icon="play"
              className="run-plan-btn"
              onClick={handleRun}
            >
              Run plan
            </Button>
            {plan && (
              <span className="rp-last-run">
                Last run {new Date(plan.generatedAt).toLocaleString()}
              </span>
            )}
          </div>

          {plan && plan.assignments.length > 0 && <PlanSummary plan={plan} />}
        </Panel>

        <PlanMarkersEditor project={project} />
      </div>

      {!plan ? (
        <EmptyState
          compact
          title="No plan yet"
          message="Press Run plan to generate a schedule from the project's tasks."
        />
      ) : (
        <PlanResults project={project} />
      )}
    </div>
  );
}

/**
 * What the last run concluded: the finish date, and how much slack rounding
 * partial days up to whole ones built into it.
 */
function PlanSummary({ plan }: { plan: NonNullable<Project["plan"]> }) {
  const { assignments } = plan;
  const finish = assignments.reduce(
    (max, a) => (a.end > max ? a.end : max),
    assignments[0].end,
  );

  // Rounding buffer as a share of the whole plan: total slack gained divided by
  // the total whole working days blocked out across every assignment.
  const roundingBuffer = plan.roundingBufferDays ?? 0;
  const totalWorkDays = assignments.reduce((sum, a) => sum + a.workDays, 0);
  const roundingPct =
    totalWorkDays > 0 ? (roundingBuffer / totalWorkDays) * 100 : 0;

  return (
    <>
      <Callout tone="success">
        <span className="completion-note">
          Estimated completion: <strong>{formatLongDate(finish)}</strong>
        </span>
      </Callout>
      {roundingBuffer > 0 && (
        <p className="rounding-note">
          Rounding buffer:{" "}
          <strong>
            +{formatDays(roundingBuffer)} working day
            {roundingBuffer === 1 ? "" : "s"}
          </strong>{" "}
          of built-in slack (<strong>{formatDays(roundingPct)}%</strong> of the{" "}
          {totalWorkDays} working day{totalWorkDays === 1 ? "" : "s"} planned).
          Each person's partial-day estimates are rounded up to whole days (e.g.
          0.5d → 1d, 1.3d → 2d), summed across all {assignments.length}{" "}
          assignment
          {assignments.length === 1 ? "" : "s"}.
        </p>
      )}
    </>
  );
}

function PlanResults({ project }: { project: Project }) {
  const { state, actions } = useAppStore();
  const toast = useToast();
  const [pushingSheets, setPushingSheets] = useState(false);
  // Narrows the overview, grids and assignment list to matching tasks/epics.
  // A per-view convenience, so it lives here rather than in the project.
  const [query, setQuery] = useState("");
  // The export/render consumers only need a flat roster (off-days keyed by the
  // member ids that appear in the plan), so merge every team into one.
  const team = useMemo(
    () => ({
      members: allMembers(state.teams),
      offDays: mergedOffDays(state.teams),
    }),
    [state.teams],
  );
  const plan = project.plan!;
  const { assignments, unassigned } = plan;

  if (assignments.length === 0) {
    return (
      <>
        <UnassignedCallout unassigned={unassigned} />
        <EmptyState
          compact
          title="No assignable tasks"
          message="Every included task is unassigned — add matching team members, then run the plan again."
        />
      </>
    );
  }

  // Markers the timelines draw (none while hidden).
  const markers = visiblePlanMarkers(project);

  // The range comes from the whole plan, so filtering never shifts the dates.
  const range = computeGanttRange(project.startDate, assignments, markers);
  const mode = planViewModeOf(project.planViewMode);
  const q = query.trim().toLowerCase();
  const shown = q ? assignments.filter((a) => matchesQuery(a, q)) : assignments;

  const handleExcel = () => {
    try {
      downloadPlanExcel(project, team);
      toast("Excel workbook downloaded.");
    } catch {
      toast("Couldn't build the Excel file.");
    }
  };

  const handleImage = async () => {
    try {
      await downloadTimelinePng(
        { project, team, mode },
        `${planFilenameStem(project)}-timeline-${mode}.png`,
      );
      toast("Timeline image downloaded.");
    } catch {
      toast("Couldn't render the timeline image.");
    }
  };

  const handleGoogleSheets = async () => {
    setPushingSheets(true);
    try {
      const wb = buildPlanWorkbook(project, team);
      const { spreadsheetUrl } = await pushWorkbookToGoogleSheets(
        wb,
        `${project.name} — Plan`,
      );
      window.open(spreadsheetUrl, "_blank", "noopener");
      toast("Opened the plan in Google Sheets.");
    } catch (err) {
      toast(
        err instanceof Error ? err.message : "Couldn't reach Google Sheets.",
      );
    } finally {
      setPushingSheets(false);
    }
  };

  return (
    <>
      <UnassignedCallout unassigned={unassigned} />

      <Panel
        className="plan-timeline-panel"
        icon={<Icon name="timeline" size={17} />}
        title="Timeline"
        subtitle={`Image export captures the current view (${VIEW_HINTS[mode]}).`}
        actions={
          <>
            <Button small icon="download" onClick={handleExcel}>
              Export to Excel
            </Button>
            <Button
              small
              icon="external"
              onClick={handleGoogleSheets}
              disabled={pushingSheets}
              title={
                isGoogleConfigured()
                  ? "Create a new Google Sheet from this plan"
                  : "Needs VITE_GOOGLE_CLIENT_ID — see docs/GOOGLE_SHEETS.md"
              }
            >
              {pushingSheets ? "Sending…" : "Send to Google Sheets"}
            </Button>
            <Button small icon="image" onClick={handleImage}>
              Save timeline image
            </Button>
          </>
        }
      >
        <div className="plan-toolbar">
          <Segmented<PlanViewMode>
            label="Schedule view"
            size="sm"
            value={mode}
            onChange={(m) => actions.setPlanViewMode(project.id, m)}
            options={[
              { value: "person", label: "Person", ariaLabel: "By person" },
              { value: "task", label: "Task", ariaLabel: "By task" },
              { value: "epic", label: "Epic", ariaLabel: "By epic" },
            ]}
          />
          <div className="plan-search-field">
            <Icon name="search" size={14} className="plan-search-icon" />
            <input
              type="search"
              className="plan-search"
              aria-label="Filter plan by task or epic"
              placeholder="Filter by task or epic…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {q && (
            <span className="muted" aria-live="polite">
              Showing {shown.length} of {assignments.length} tasks
            </span>
          )}
        </div>

        {shown.length > 0 ? (
          <>
            <OverviewTimeline
              assignments={shown}
              range={range}
              markers={markers}
            />
            {mode === "person" ? (
              <GanttByPerson
                assignments={shown}
                team={team}
                range={range}
                markers={markers}
              />
            ) : mode === "epic" ? (
              <GanttByEpic
                assignments={shown}
                epics={project.epics}
                unassigned={unassigned}
                range={range}
                markers={markers}
              />
            ) : (
              <GanttByTask
                assignments={shown}
                epics={project.epics}
                offDays={team.offDays}
                range={range}
                markers={markers}
              />
            )}
            <GanttLegend
              offDays={mode !== "epic"}
              markers={markers.length > 0}
            />
          </>
        ) : (
          <p className="muted plan-search-empty">
            No tasks or epics match “{query.trim()}”.
          </p>
        )}
      </Panel>

      <div className="plan-tables">
        <TeamBreakdown assignments={assignments} teams={state.teams} />
        {shown.length > 0 && <AssignmentsTable assignments={shown} />}
      </div>
    </>
  );
}

/** Key to the shading and lines every gantt view draws. */
function GanttLegend({
  offDays,
  markers,
}: {
  offDays: boolean;
  markers: boolean;
}) {
  return (
    <ul className="gantt-legend" aria-label="Timeline legend">
      <li>
        <span className="legend-swatch weekend" aria-hidden="true" /> Weekend
      </li>
      {offDays && (
        <li>
          <span className="legend-swatch nonwork" aria-hidden="true" /> Day off
        </li>
      )}
      <li>
        <span className="legend-line today" aria-hidden="true" /> Today
      </li>
      {markers && (
        <li>
          <span className="legend-diamond" aria-hidden="true" /> Marker
        </li>
      )}
    </ul>
  );
}
