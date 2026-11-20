import {
  type ID,
  type Project,
  type Team,
  fromISO,
  toISO,
  includedTeams,
  visiblePlanMarkers,
} from "@planner/core";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { IconButton } from "../ui/IconButton";
import { IconTile } from "../ui/IconTile";
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

/** "Dec 18, 2026": the finish date reads better with its year. */
function formatLongDate(iso: string): string {
  return formatDate(iso) + ", " + fromISO(iso).getFullYear();
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
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
  /** Download just this project as JSON; the button is hidden without it. */
  onExport?: (id: string) => void;
  onDelete: (id: string) => void;
}

export function ProjectCard({
  project,
  teams = [],
  onOpen,
  onCopy,
  onExport,
  onDelete,
}: ProjectCardProps) {
  const stats = projectStats(project);
  const completes = completesOn(project);
  const assignments = project.plan?.assignments ?? [];
  const summary = planSummary(project, teams);
  const markers = visiblePlanMarkers(project);

  return (
    <article
      className="project-card"
      style={
        project.titleColor
          ? { ["--project-tint" as string]: project.titleColor }
          : undefined
      }
    >
      <div className="project-card-head">
        <IconTile icon="folder" color={project.titleColor} />
        <div className="project-card-heading">
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
          >
            {project.name}
          </h3>
          <div
            className="project-card-teams"
            title="Teams working this project"
          >
            {summary.teams.length === 0 ? (
              <span className="muted">No teams yet</span>
            ) : (
              summary.teams.map((t, i) => (
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
              ))
            )}
          </div>
        </div>
        <Badge
          tone={summary.buffer > 0 ? "warning" : "neutral"}
          className="badge-buffer"
          title="Estimate buffer padding applied to every task in this plan"
        >
          Buffer {summary.buffer}%
        </Badge>
      </div>

      <div className="project-card-body">
        <dl className="project-card-stats">
          <div>
            <dt>Epics</dt>
            <dd>{stats.epics}</dd>
          </div>
          <div>
            <dt>Tasks</dt>
            <dd>{stats.tasks}</dd>
          </div>
          <div>
            <dt>Estimate</dt>
            <dd>{plural(stats.activeDays, "day", "days")}</dd>
          </div>
          <div>
            <dt>Planned finish</dt>
            <dd>
              {completes ? (
                formatLongDate(completes)
              ) : (
                <span className="muted not-planned">Not planned yet</span>
              )}
            </dd>
          </div>
        </dl>

        {summary.helpers.length > 0 && (
          <div
            className="project-card-line"
            title="Additional support (helpers), by specialization"
          >
            <Icon name="users" size={14} />
            <span>
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

        {assignments.length > 0 && (
          <OverviewTimeline
            assignments={assignments}
            range={computeGanttRange(project.startDate, assignments, markers)}
            markers={markers}
          />
        )}

        {project.note ? (
          <p
            className="project-card-line project-card-note"
            title={project.note}
          >
            <Icon name="info" size={14} />
            <span>{project.note}</span>
          </p>
        ) : null}
      </div>

      <div className="project-card-actions">
        <Button small onClick={() => onOpen(project.id)}>
          Open
        </Button>
        <Button
          small
          variant="ghost"
          icon="copy"
          onClick={() => onCopy(project.id)}
        >
          Copy
        </Button>
        <span className="spacer" />
        {onExport && (
          <IconButton
            label={`Export ${project.name}`}
            onClick={() => onExport(project.id)}
          >
            <Icon name="download" size={15} />
          </IconButton>
        )}
        <IconButton
          danger
          label={`Delete ${project.name}`}
          onClick={() => onDelete(project.id)}
        >
          <Icon name="trash" size={15} />
        </IconButton>
      </div>
    </article>
  );
}
