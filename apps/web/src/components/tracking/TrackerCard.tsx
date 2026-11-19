import { useMemo } from "react";
import { trackerStatus, type AppState, type Tracker } from "@planner/core";
import { Button } from "../ui/Button";
import { statusLabel } from "./StatusPanel";
import { STALE_AFTER_DAYS, snapshotAgeDays } from "../../lib/refreshTracker";

interface TrackerCardProps {
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

export function TrackerCard({
  tracker,
  state,
  today,
  now,
  busy,
  onOpen,
  onRefresh,
  onDelete,
}: TrackerCardProps) {
  const project = tracker.projectId
    ? state.projects.find((p) => p.id === tracker.projectId)
    : undefined;

  const status = useMemo(
    () => trackerStatus(tracker, project, state.teams, today),
    [tracker, project, state.teams, today],
  );
  const label = statusLabel(status);
  const age = snapshotAgeDays(tracker, now);
  const stale = age !== null && age >= STALE_AFTER_DAYS;

  return (
    <div className="card tracker-card">
      <div className="tracker-card-head">
        <button
          type="button"
          className="tracker-title"
          onClick={() => onOpen(tracker.id)}
        >
          <span className="tracker-key">{tracker.initiativeKey}</span>
          <span className="tracker-name">{tracker.name}</span>
        </button>
      </div>

      <p className="muted tracker-meta">
        {project ? `Baseline: ${project.name}` : "No baseline plan"}
        {" · "}
        <span className={stale ? "stale" : undefined}>{ageText(age)}</span>
      </p>

      <p className={"status-line small " + label.tone}>
        <span aria-hidden="true" className="status-glyph">
          {label.glyph}
        </span>
        <span>{label.text}</span>
      </p>
      {label.endDate && <p className="muted tracker-meta">{label.endDate}</p>}

      <div className="tracker-card-actions">
        <Button small onClick={() => onRefresh(tracker.id)} disabled={busy}>
          {busy ? "Refreshing…" : "Refresh"}
        </Button>
        <Button small onClick={() => onOpen(tracker.id)}>
          Open
        </Button>
        <span className="spacer" />
        <Button small variant="danger" onClick={() => onDelete(tracker.id)}>
          Delete
        </Button>
      </div>
    </div>
  );
}
