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
  planMarkersOf,
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
import { EmptyState } from "../ui/EmptyState";
import { useToast } from "../ui/Toast";
import { computeGanttRange, formatShortDate } from "./DateGrid";
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

export function RunPlanPanel({ project }: RunPlanPanelProps) {
  const { state, actions } = useAppStore();
  const plan = project.plan;
  const mode = project.planMode === "smart" ? "smart" : "balanced";
  const lookahead = project.planLookahead ?? 5;
  const buffer = project.buffer ?? 0;

  const handleRun = () => {
    actions.setPlan(
      project.id,
      runPlan(project, state.teams, undefined, { mode, lookahead }),
    );
  };

  return (
    <section className="run-plan-panel">
      <h2 className="section-title">Run plan</h2>
      <div className="info-box">
        {mode === "smart" ? (
          <>
            <strong>Smart (days-off aware).</strong> Instead of taking tasks
            strictly top → bottom, whoever is free earliest picks the
            best-fitting task among the next {lookahead} in line — preferring
            work that finishes before their own next break, so a long task isn't
            handed to someone about to take time off when a colleague could take
            it instead. Weekends, days off, and dependencies are all respected.
          </>
        ) : (
          <>
            <strong>Balanced.</strong> Tasks are scheduled in the order shown
            above (top → bottom, use ▲▼ to reprioritize). Each included task
            goes to the matching-specialization member who can start it soonest
            — accounting for weekends and each person's marked days off. Skipped
            tasks are ignored.
          </>
        )}
      </div>

      <div className="plan-mode-row">
        <div className="seg-toggle" role="group" aria-label="Planning mode">
          <button
            type="button"
            className={"seg-btn" + (mode === "balanced" ? " active" : "")}
            aria-pressed={mode === "balanced"}
            onClick={() => actions.setPlanMode(project.id, "balanced")}
          >
            ⚖️ Balanced
          </button>
          <button
            type="button"
            className={"seg-btn" + (mode === "smart" ? " active" : "")}
            aria-pressed={mode === "smart"}
            onClick={() => actions.setPlanMode(project.id, "smart")}
          >
            🧠 Smart (days-off aware)
          </button>
        </div>

        {mode === "smart" && (
          <label className="lookahead-control">
            <span>
              Look ahead: <strong>{lookahead}</strong> task
              {lookahead === 1 ? "" : "s"}
            </span>
            <input
              type="range"
              min={1}
              max={15}
              step={1}
              value={lookahead}
              onChange={(e) =>
                actions.setPlanMode(project.id, "smart", Number(e.target.value))
              }
              aria-label="Lookahead window size"
            />
            <span className="muted lookahead-hint">
              Smaller = stick closer to your priority order; larger = more
              freedom to optimize around days off.
            </span>
          </label>
        )}
      </div>

      <div className="buffer-row">
        <label className="lookahead-control">
          <span>
            Estimate buffer: <strong>{buffer}%</strong>
            {buffer > 0 && (
              <span className="muted">
                {" "}
                (a 5-day task plans as {(5 * (1 + buffer / 100)).toFixed(1)}d)
              </span>
            )}
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
          <span className="muted lookahead-hint">
            Pads every task's estimate before scheduling — bump the whole plan
            up for uncertainty without editing individual tasks.
          </span>
        </label>
      </div>

      <PlanMarkersEditor project={project} />

      <div className="run-row">
        <Button variant="primary" onClick={handleRun}>
          ▶ Run Plan
        </Button>
        {plan && (
          <span className="muted">
            Last run {new Date(plan.generatedAt).toLocaleString()}
          </span>
        )}
      </div>

      {!plan ? (
        <EmptyState
          compact
          title="No plan yet"
          message="Click Run Plan to generate a schedule from the epics above."
        />
      ) : (
        <PlanResults project={project} />
      )}
    </section>
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

  // Markers the timelines draw (none while hidden), and how many exist at all
  // so the show/hide toggle appears only when there is something to toggle.
  const markers = visiblePlanMarkers(project);
  const markerCount = planMarkersOf(project).length;
  const markersShown = !project.hideMarkers;

  // The range comes from the whole plan, so filtering never shifts the dates.
  const range = computeGanttRange(project.startDate, assignments, markers);
  const mode = planViewModeOf(project.planViewMode);
  const q = query.trim().toLowerCase();
  const shown = q ? assignments.filter((a) => matchesQuery(a, q)) : assignments;

  // Rounding buffer as a share of the whole plan: total slack gained divided by
  // the total whole working days blocked out across every assignment.
  const roundingBuffer = plan.roundingBufferDays ?? 0;
  const totalWorkDays = assignments.reduce((sum, a) => sum + a.workDays, 0);
  const roundingPct =
    totalWorkDays > 0 ? (roundingBuffer / totalWorkDays) * 100 : 0;

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
      <p className="completion-note">
        Estimated completion: <strong>{formatShortDate(range.rangeEnd)}</strong>
      </p>
      {roundingBuffer > 0 && (
        <p className="completion-note rounding-note">
          Rounding buffer:{" "}
          <strong>
            +{formatDays(roundingBuffer)} working day
            {roundingBuffer === 1 ? "" : "s"}
          </strong>{" "}
          of built-in slack (<strong>{formatDays(roundingPct)}%</strong> of the{" "}
          {totalWorkDays} working day{totalWorkDays === 1 ? "" : "s"} planned) —
          each person's partial-day estimates are rounded up to whole days (e.g.
          0.5d → 1d, 1.3d → 2d), summed across all {assignments.length}{" "}
          assignment
          {assignments.length === 1 ? "" : "s"}.
        </p>
      )}

      <div className="export-row">
        <Button small onClick={handleExcel}>
          ⬇ Export to Excel
        </Button>
        <Button
          small
          onClick={handleGoogleSheets}
          disabled={pushingSheets}
          title={
            isGoogleConfigured()
              ? "Create a new Google Sheet from this plan"
              : "Needs VITE_GOOGLE_CLIENT_ID — see docs/GOOGLE_SHEETS.md"
          }
        >
          {pushingSheets ? "⏳ Sending…" : "📗 Send to Google Sheets"}
        </Button>
        <Button small onClick={handleImage}>
          🖼 Save timeline image
        </Button>
        <span className="muted export-hint">
          Image captures the current view ({VIEW_HINTS[mode]}).
        </span>
      </div>

      <div className="plan-search-row">
        <input
          type="text"
          className="plan-search"
          aria-label="Filter plan by task or epic"
          placeholder="Filter by task or epic…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {q && (
          <span className="muted" aria-live="polite">
            Showing {shown.length} of {assignments.length} tasks
          </span>
        )}
      </div>

      {markerCount > 0 && (
        <label className="markers-toggle">
          <input
            type="checkbox"
            checked={markersShown}
            onChange={(e) =>
              actions.setMarkersHidden(project.id, !e.target.checked)
            }
          />
          Show timeline markers ({markerCount})
        </label>
      )}

      {shown.length > 0 ? (
        <OverviewTimeline assignments={shown} range={range} markers={markers} />
      ) : (
        <p className="muted plan-search-empty">
          No tasks or epics match “{query.trim()}”.
        </p>
      )}

      <div className="seg-toggle" role="group" aria-label="Schedule view">
        <button
          type="button"
          className={"seg-btn" + (mode === "person" ? " active" : "")}
          aria-pressed={mode === "person"}
          onClick={() => actions.setPlanViewMode(project.id, "person")}
        >
          📅 Grid by Person
        </button>
        <button
          type="button"
          className={"seg-btn" + (mode === "task" ? " active" : "")}
          aria-pressed={mode === "task"}
          onClick={() => actions.setPlanViewMode(project.id, "task")}
        >
          📋 Grid by Task
        </button>
        <button
          type="button"
          className={"seg-btn" + (mode === "epic" ? " active" : "")}
          aria-pressed={mode === "epic"}
          onClick={() => actions.setPlanViewMode(project.id, "epic")}
        >
          🗂 Grid by Epic
        </button>
      </div>

      {shown.length === 0 ? null : mode === "person" ? (
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

      <TeamBreakdown assignments={assignments} teams={state.teams} />

      {shown.length > 0 && <AssignmentsTable assignments={shown} />}
    </>
  );
}
