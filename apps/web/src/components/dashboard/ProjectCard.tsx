import {
  type ID,
  type Project,
  type Team,
  fromISO,
  toISO,
  includedTeams,
  visiblePlanMarkers,
} from "@planner/core";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { computeGanttRange } from "../schedule/DateGrid";
import { OverviewTimeline } from "../schedule/OverviewTimeline";

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function formatDate(iso: string): string {
  const d = fromISO(iso);
  return MONTHS[d.getMonth()] + " " + d.getDate();
}

export interface ProjectStats {
  epics: number;
  tasks: number;
  activeDays: number;
}

export function projectStats(project: Project): ProjectStats {
  let tasks = 0;
  let activeDays = 0;
  for (const epic of project.epics) {
    for (const t of epic.tasks) {
      tasks++;
      if (!t.excluded) activeDays += Number(t.estimateDays) || 0;
    }
  }
  return { epics: project.epics.length, tasks, activeDays };
}

/** Latest assignment end date if the project has been planned, else null. */
export function completesOn(project: Project): string | null {
  const a = project.plan?.assignments;
  if (!a || a.length === 0) return null;
  return a.reduce((max, cur) => (cur.end > max ? cur.end : max), a[0].end);
}

/** Trim + lowercase, for case-insensitive specialization grouping. */
function norm(s: string): string {
  return String(s ?? "")
    .trim()
    .toLowerCase();
}

/** The later of two dates (either may be null). */
function laterOf(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return b.getTime() > a.getTime() ? b : a;
}

/** A participating team, with the date it effectively starts if that's later
 *  than the project start (a team held back by its availability window or by
 *  every member having a later start override). null = starts with the project. */
export interface TeamSummary {
  id: ID;
  name: string;
  startsLate: string | null;
}

/** Per-specialization roll-up of the project's helpers ("additional support"):
 *  how many of each type and the average date they become available. */
export interface HelperGroup {
  specialization: string;
  count: number;
  avgStart: string; // ISO
}

export interface PlanSummary {
  teams: TeamSummary[];
  helpers: HelperGroup[];
  /** Estimate buffer padding in use, as a percentage (0 = none). */
  buffer: number;
}

/**
 * Roll up the staffing picture for a project card: which teams work it (and
 * when a team starts late), the helper support broken down by specialization
 * with each type's average availability date, and the buffer % in use.
 */
export function planSummary(project: Project, teams: Team[]): PlanSummary {
  const projectStart = fromISO(project.startDate);
  const memberStarts = project.memberStarts ?? {};

  const teamSummaries: TeamSummary[] = includedTeams(project, teams).map(
    (team) => {
      const inc = project.teamInclusions?.find((i) => i.teamId === team.id);
      const availFrom = inc?.availableFrom ? fromISO(inc.availableFrom) : null;

      // The earliest a member of this team can begin: for each member the
      // latest of the project start, their own start override, and the team's
      // availability window; the team starts when its first member can.
      let earliest: Date | null = null;
      for (const m of team.members) {
        const override = memberStarts[m.id]
          ? fromISO(memberStarts[m.id])
          : null;
        const start = laterOf(laterOf(projectStart, override), availFrom)!;
        if (earliest === null || start.getTime() < earliest.getTime()) {
          earliest = start;
        }
      }
      // A team with no members is still constrained by its availability window.
      if (earliest === null) earliest = laterOf(projectStart, availFrom)!;

      const startsLate =
        earliest.getTime() > projectStart.getTime() ? toISO(earliest) : null;
      return { id: team.id, name: team.name, startsLate };
    },
  );

  // Group helpers by specialization, averaging their availability start dates.
  const groups = new Map<string, { label: string; froms: number[] }>();
  for (const h of project.helpers ?? []) {
    const key = norm(h.specialization);
    const g = groups.get(key) ?? {
      label: h.specialization.trim() || "Support",
      froms: [],
    };
    g.froms.push(fromISO(h.availableFrom).getTime());
    groups.set(key, g);
  }
  const helpers: HelperGroup[] = [...groups.values()].map((g) => {
    const avg = g.froms.reduce((s, t) => s + t, 0) / g.froms.length;
    return {
      specialization: g.label,
      count: g.froms.length,
      avgStart: toISO(new Date(avg)),
    };
  });

  return { teams: teamSummaries, helpers, buffer: project.buffer ?? 0 };
}

interface ProjectCardProps {
  project: Project;
  /** Every team in the app; used to summarise who works this project. */
  teams?: Team[];
  onOpen: (id: string) => void;
  onCopy: (id: string) => void;
  onDelete: (id: string) => void;
}

export function ProjectCard({
  project,
  teams = [],
  onOpen,
  onCopy,
  onDelete,
}: ProjectCardProps) {
  const stats = projectStats(project);
  const completes = completesOn(project);
  const assignments = project.plan?.assignments ?? [];
  const summary = planSummary(project, teams);

  return (
    <div className="project-card">
      <h3
        className="project-card-title"
        role="button"
        tabIndex={0}
        onClick={() => onOpen(project.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen(project.id);
          }
        }}
        style={project.titleColor ? { color: project.titleColor } : undefined}
      >
        {project.name}
      </h3>
      {project.note ? (
        <p className="project-card-note">{project.note}</p>
      ) : null}
      <div className="stat-line">
        <span>{stats.epics} epics</span>
        <span>{stats.tasks} tasks</span>
        <span>{stats.activeDays}d planned</span>
      </div>

      {summary.teams.length > 0 && (
        <div className="card-meta-line" title="Teams working this project">
          <span className="card-meta-icon" aria-hidden>
            👥
          </span>
          <span className="card-meta-text">
            {summary.teams.map((t, i) => (
              <span key={t.id}>
                {i > 0 && ", "}
                {t.name}
                {t.startsLate && (
                  <span className="muted">
                    {" "}
                    (from {formatDate(t.startsLate)})
                  </span>
                )}
              </span>
            ))}
          </span>
        </div>
      )}

      {summary.helpers.length > 0 && (
        <div
          className="card-meta-line"
          title="Additional support (helpers), by specialization"
        >
          <span className="card-meta-icon" aria-hidden>
            ➕
          </span>
          <span className="card-meta-text">
            {summary.helpers.map((h, i) => (
              <span key={i}>
                {i > 0 && ", "}
                {h.count} {h.specialization}
                <span className="muted">
                  {" "}
                  (avg start {formatDate(h.avgStart)})
                </span>
              </span>
            ))}
          </span>
        </div>
      )}

      <div className="card-badges">
        <span
          className="badge badge-buffer"
          title="Estimate buffer padding applied to every task in this plan"
        >
          Buffer {summary.buffer}%
        </span>
        {completes ? (
          <span className="badge">Completes {formatDate(completes)}</span>
        ) : (
          <span className="muted not-planned">Not planned yet</span>
        )}
      </div>
      {assignments.length > 0 && (
        <OverviewTimeline
          assignments={assignments}
          range={computeGanttRange(
            project.startDate,
            assignments,
            visiblePlanMarkers(project),
          )}
          markers={visiblePlanMarkers(project)}
        />
      )}
      <div className="row card-actions">
        <Button small onClick={() => onOpen(project.id)}>
          Open
        </Button>
        <Button small onClick={() => onCopy(project.id)}>
          Copy
        </Button>
        <span className="spacer" />
        <IconButton
          danger
          label={`Delete ${project.name}`}
          onClick={() => onDelete(project.id)}
        >
          ✕
        </IconButton>
      </div>
    </div>
  );
}
