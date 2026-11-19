import { useState, type FormEvent, type KeyboardEvent } from "react";
import { type PlanMarker, type Project, planMarkersOf } from "@planner/core";
import { useAppStore } from "@planner/client-runtime";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";

interface PlanMarkersEditorProps {
  project: Project;
}

/**
 * Named dates (an alpha gate, a beta gate, an internal test) drawn as lines
 * on the plan's timelines. Annotations only: the scheduler never reads them.
 * Whether the timelines show them is toggled next to the timelines.
 */
export function PlanMarkersEditor({ project }: PlanMarkersEditorProps) {
  const { actions } = useAppStore();
  const markers = planMarkersOf(project);

  return (
    <div className="markers-editor">
      <div className="markers-head">
        <strong>Timeline markers</strong>{" "}
        <span className="muted">
          Optional named dates, e.g. an alpha gate, a beta gate or an internal
          test, drawn as lines on the plan's timelines. They don't change the
          schedule.
        </span>
      </div>

      {markers.length > 0 && (
        <ul className="marker-list" aria-label="Timeline markers">
          {markers.map((m) => (
            <MarkerRow key={m.id} projectId={project.id} marker={m} />
          ))}
        </ul>
      )}

      <AddMarkerForm
        defaultDate={project.startDate}
        onAdd={(marker) => actions.addPlanMarker(project.id, marker)}
      />
    </div>
  );
}

function blurOnEnter(e: KeyboardEvent<HTMLInputElement>) {
  if (e.key === "Enter") {
    e.preventDefault();
    e.currentTarget.blur();
  }
}

function MarkerRow({
  projectId,
  marker,
}: {
  projectId: string;
  marker: PlanMarker;
}) {
  const { actions } = useAppStore();
  const [name, setName] = useState(marker.name);

  const commitName = () => {
    const next = name.trim();
    if (!next) {
      setName(marker.name);
      return;
    }
    if (next !== marker.name)
      actions.editPlanMarker(projectId, marker.id, { name: next });
  };

  return (
    <li className="marker-row">
      <span className="marker-swatch" aria-hidden="true" />
      <input
        type="text"
        aria-label="Marker name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={commitName}
        onKeyDown={blurOnEnter}
      />
      <input
        type="date"
        aria-label={`${marker.name} date`}
        value={marker.date}
        onChange={(e) => {
          // A cleared date input reports ""; keep the old date rather than
          // store a marker the timelines cannot place.
          if (e.target.value)
            actions.editPlanMarker(projectId, marker.id, {
              date: e.target.value,
            });
        }}
      />
      <IconButton
        danger
        label={`Remove ${marker.name}`}
        onClick={() => actions.deletePlanMarker(projectId, marker.id)}
      >
        ✕
      </IconButton>
    </li>
  );
}

function AddMarkerForm({
  defaultDate,
  onAdd,
}: {
  defaultDate: string;
  onAdd: (marker: { name: string; date: string }) => void;
}) {
  const [name, setName] = useState("");
  const [date, setDate] = useState(defaultDate);
  const canAdd = name.trim() !== "" && date !== "";

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canAdd) return;
    onAdd({ name: name.trim(), date });
    setName("");
  };

  return (
    <form className="marker-add" onSubmit={submit}>
      <input
        type="text"
        aria-label="New marker name"
        placeholder="e.g. Alpha gate"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        type="date"
        aria-label="New marker date"
        value={date}
        onChange={(e) => setDate(e.target.value)}
      />
      <Button small type="submit" disabled={!canAdd}>
        + Add marker
      </Button>
    </form>
  );
}
