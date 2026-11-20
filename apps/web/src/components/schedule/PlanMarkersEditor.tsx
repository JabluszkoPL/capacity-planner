import { useState, type FormEvent, type KeyboardEvent } from "react";
import { type PlanMarker, type Project, planMarkersOf } from "@planner/core";
import { useAppStore } from "@planner/client-runtime";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { IconButton } from "../ui/IconButton";
import { Panel } from "../ui/Panel";

interface PlanMarkersEditorProps {
  project: Project;
}

/**
 * Named dates (an alpha gate, a beta gate, an internal test) drawn as lines
 * on the plan's timelines. Annotations only: the scheduler never reads them.
 * The panel header carries the switch that shows or hides them on the
 * timelines, present only while there is a marker to show.
 */
export function PlanMarkersEditor({ project }: PlanMarkersEditorProps) {
  const { actions } = useAppStore();
  const markers = planMarkersOf(project);

  return (
    <Panel
      className="markers-editor"
      icon={<Icon name="flag" size={17} />}
      title="Timeline markers"
      subtitle="Named dates such as an alpha or beta gate, drawn on the timelines. They don't change the schedule."
      actions={
        markers.length > 0 && (
          <label className="markers-toggle">
            <input
              type="checkbox"
              checked={!project.hideMarkers}
              onChange={(e) =>
                actions.setMarkersHidden(project.id, !e.target.checked)
              }
            />
            Show timeline markers ({markers.length})
          </label>
        )
      }
    >
      {markers.length > 0 ? (
        <ul className="marker-list" aria-label="Timeline markers">
          {markers.map((m) => (
            <MarkerRow key={m.id} projectId={project.id} marker={m} />
          ))}
        </ul>
      ) : (
        <p className="marker-empty muted">No markers yet.</p>
      )}

      <AddMarkerForm
        defaultDate={project.startDate}
        onAdd={(marker) => actions.addPlanMarker(project.id, marker)}
      />
    </Panel>
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
      <Icon name="flag" size={15} className="marker-flag" />
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
        <Icon name="x" size={15} />
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
      <Button small icon="plus" type="submit" disabled={!canAdd}>
        Add marker
      </Button>
    </form>
  );
}
