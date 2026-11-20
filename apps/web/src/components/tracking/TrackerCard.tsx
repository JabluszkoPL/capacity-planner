import { useMemo } from "react";
import { trackerStatus, type AppState, type Tracker } from "@planner/core";
import { Badge, Button, Icon, IconButton, IconTile } from "../ui";
import { days, statusBadge, statusLabel } from "./StatusPanel";
import { STALE_AFTER_DAYS, snapshotAgeDays } from "../../lib/refreshTracker";

interface TrackerRowProps {
  tracker: Tracker;
  state: AppState;
  today: string;
  now: string;
  busy?: boolean;
  onOpen: (id: string) => void;
  onRefresh: (id: string) => void;
  onDelete: (id: string) => void;
}

function ageText(age: number | null): string {
  if (age === null) return "Never refreshed";
  if (age <= 0) return "Refreshed today";
  if (age === 1) return "Refreshed yesterday";
  return `Refreshed ${age} days ago`;
}

/**
 * One tracker in the portfolio table: which initiative, against which plan,
 * how it stands, and when that reading was taken. Everything is computed the
 * way the tracker's own page computes it (`trackerStatus`), so the two never
 * disagree.
 */
export function TrackerRow({
  tracker,
  state,
  today,
  now,
  busy,
  onOpen,
  onRefresh,
  onDelete,
}: TrackerRowProps) {
  const project = tracker.projectId
    ? state.projects.find((p) => p.id === tracker.projectId)
    : undefined;

  const status = useMemo(
    () => trackerStatus(tracker, project, state.teams, today),
    [tracker, project, state.teams, today],
  );
  const label = statusLabel(status);
  const badge = statusBadge(status);
  const comparable = status.kind !== "no-baseline";
  const age = snapshotAgeDays(tracker, now);
  const stale = age !== null && age >= STALE_AFTER_DAYS;
  const fetchedAt = tracker.snapshot?.fetchedAt;

  const bufferLeft = Math.max(0, status.bufferDays - status.bufferUsedDays);
  const bufferPct =
    status.bufferDays > 0
      ? Math.round((bufferLeft / status.bufferDays) * 100)
      : 0;

  return (
    <tr className="tracker-row">
      <td>
        <button
          type="button"
          className="tracker-title"
          onClick={() => onOpen(tracker.id)}
        >
          <Icon name="jira" size={16} className="tracker-title-icon" />
          <span className="tracker-title-text">
            <span className="tracker-key">{tracker.initiativeKey}</span>
            <span className="tracker-name">{tracker.name}</span>
          </span>
        </button>
      </td>
      <td>
        {project ? (
          <span className="tracker-project">
            <IconTile icon="rocket" size="sm" color={project.titleColor} />
            <span className="tracker-project-text">
              <span className="tracker-project-name">{project.name}</span>
              {project.startDate && (
                <span className="muted">From {project.startDate}</span>
              )}
            </span>
          </span>
        ) : (
          <span className="muted">No baseline plan</span>
        )}
      </td>
      <td>
        <span className="tracker-health" title={label.text}>
          <Badge
            tone={badge.tone}
            icon={
              <span aria-hidden="true" className="badge-glyph">
                {label.glyph}
              </span>
            }
          >
            {badge.word}
          </Badge>
          <span className="tracker-health-text">{label.text}</span>
        </span>
      </td>
      <td>
        <span className={"tracker-age" + (stale ? " stale" : "")}>
          {fetchedAt ? fetchedAt.slice(0, 16).replace("T", " ") : "—"}
        </span>
        <span className={"tracker-meta" + (stale ? " stale" : " muted")}>
          {ageText(age)}
        </span>
      </td>
      <td className="num">
        {comparable && status.bufferDays > 0 ? (
          <>
            {days(bufferLeft)} d <span className="muted">({bufferPct}%)</span>
            {status.overrunDays > 0 && (
              <span className="tracker-meta status-cell bad">
                {days(status.overrunDays)} d over
              </span>
            )}
          </>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td>
        <span className="tracker-finish">
          {comparable ? (status.projectedFinish ?? "—") : "—"}
        </span>
        {comparable && (status.deadline ?? status.bufferedEnd) && (
          <span className="tracker-meta muted">
            due {status.deadline ?? status.bufferedEnd}
          </span>
        )}
      </td>
      <td className="tracker-row-actions">
        <Button
          small
          icon="refresh"
          onClick={() => onRefresh(tracker.id)}
          disabled={busy}
        >
          {busy ? "Refreshing…" : "Refresh"}
        </Button>
        <Button small onClick={() => onOpen(tracker.id)}>
          Open
        </Button>
        <IconButton
          danger
          label={`Delete ${tracker.initiativeKey}`}
          onClick={() => onDelete(tracker.id)}
        >
          <Icon name="trash" size={15} />
        </IconButton>
      </td>
    </tr>
  );
}
