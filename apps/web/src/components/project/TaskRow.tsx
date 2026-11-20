import {
  useEffect,
  useMemo,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import {
  type Epic,
  type TaskItem,
  colorFor,
  projectSpecializations,
} from "@planner/core";
import { useAppStore } from "@planner/client-runtime";
import { Chip } from "../ui/Chip";
import { ComboInput } from "../ui/ComboInput";
import { IconButton } from "../ui/IconButton";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { Icon } from "../ui/Icon";
import { DependencyPicker } from "./DependencyPicker";

interface TaskRowProps {
  projectId: string;
  epicId: string;
  task: TaskItem;
  /** All epics in the project, so this task can depend on any other task. */
  allEpics: Epic[];
  isFirst: boolean;
  isLast: boolean;
  /** Position within the epic's task list, for drag-and-drop reordering. */
  index: number;
  isDragging: boolean;
  isDragOver: boolean;
  onDragStart: (index: number) => void;
  onDragOverRow: (index: number) => void;
  onDrop: () => void;
  onDragEnd: () => void;
}

/** Blur the field on Enter, which triggers the onBlur commit. */
function blurOnEnter(e: KeyboardEvent<HTMLInputElement>) {
  if (e.key === "Enter") {
    e.preventDefault();
    e.currentTarget.blur();
  }
}

export function TaskRow({
  projectId,
  epicId,
  task,
  allEpics,
  isFirst,
  isLast,
  index,
  isDragging,
  isDragOver,
  onDragStart,
  onDragOverRow,
  onDrop,
  onDragEnd,
}: TaskRowProps) {
  const { state, actions } = useAppStore();
  const [depsOpen, setDepsOpen] = useState(false);
  const deps = task.dependsOn ?? [];

  // The row only becomes draggable while the grab handle is held, so text
  // selection inside the inputs keeps working normally.
  const [grabbed, setGrabbed] = useState(false);

  const handleDragStart = (e: DragEvent<HTMLTableRowElement>) => {
    e.dataTransfer.effectAllowed = "move";
    // Firefox needs data set for a drag to start at all.
    e.dataTransfer.setData("text/plain", task.id);
    onDragStart(index);
  };
  const handleDragOver = (e: DragEvent<HTMLTableRowElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    onDragOverRow(index);
  };
  const handleDrop = (e: DragEvent<HTMLTableRowElement>) => {
    e.preventDefault();
    onDrop();
  };
  const handleDragEnd = () => {
    setGrabbed(false);
    onDragEnd();
  };

  // Local drafts so typing never dispatches (no per-keystroke re-render of the
  // list, no lost focus). Commit to the store on blur / Enter. Re-sync if the
  // committed value changes underneath us.
  const [name, setName] = useState(task.name);
  const [estimate, setEstimate] = useState(String(task.estimateDays));
  const [spec, setSpec] = useState(task.specialization);

  useEffect(() => setName(task.name), [task.name]);
  useEffect(() => setEstimate(String(task.estimateDays)), [task.estimateDays]);
  useEffect(() => setSpec(task.specialization), [task.specialization]);

  const commitName = () => {
    const next = name.trim();
    if (next !== task.name)
      actions.editTask(projectId, epicId, task.id, { name: next });
  };
  const commitEstimate = () => {
    const next = Math.max(0, Number(estimate) || 0);
    if (next !== task.estimateDays)
      actions.editTask(projectId, epicId, task.id, { estimateDays: next });
    else setEstimate(String(task.estimateDays)); // normalize display
  };
  const commitSpec = (value: string) => {
    const next = value.trim();
    if (next !== task.specialization)
      actions.editTask(projectId, epicId, task.id, { specialization: next });
  };

  // Suggestions come from the teams selected on this project (all teams if
  // none is selected yet); any other value can still be typed.
  const project = state.projects.find((p) => p.id === projectId);
  const specOptions = useMemo(
    () => (project ? projectSpecializations(project, state.teams) : []),
    [project, state.teams],
  );

  // The first dependency by name, so the column reads like the plan does.
  const depNames = deps
    .map((id) => {
      for (const e of allEpics) {
        const t = e.tasks.find((x) => x.id === id);
        if (t) return t.name;
      }
      return null;
    })
    .filter((n): n is string => n !== null);

  const rowClass = [
    task.excluded ? "excluded" : "",
    isDragging ? "dragging" : "",
    isDragOver && !isDragging ? "drag-over" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <tr
      className={rowClass}
      draggable={grabbed}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onDragEnd={handleDragEnd}
    >
      <td>
        <div className="order-cell">
          <span
            className="drag-handle"
            role="button"
            aria-label={`Drag to reorder ${task.name}`}
            title="Drag to reorder"
            onMouseDown={() => setGrabbed(true)}
            onMouseUp={() => setGrabbed(false)}
          >
            ⠿
          </span>
          <IconButton
            label="Move task up"
            disabled={isFirst}
            onClick={() => actions.reorderTask(projectId, epicId, task.id, -1)}
          >
            <Icon name="chevronDown" size={13} className="icon-flip" />
          </IconButton>
          <IconButton
            label="Move task down"
            disabled={isLast}
            onClick={() => actions.reorderTask(projectId, epicId, task.id, 1)}
          >
            <Icon name="chevronDown" size={13} />
          </IconButton>
        </div>
      </td>
      <td className="task-name-cell">
        <input
          type="text"
          className="task-name-input"
          aria-label="Task name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={blurOnEnter}
        />
      </td>
      <td>
        <input
          type="number"
          min="0"
          step="0.5"
          className="est-input"
          aria-label="Estimate in days"
          value={estimate}
          onChange={(e) => setEstimate(e.target.value)}
          onBlur={commitEstimate}
          onKeyDown={blurOnEnter}
        />
      </td>
      <td>
        <div
          className={"spec-cell" + (spec.trim() ? " has-spec" : "")}
          style={{ ["--tag" as string]: colorFor(spec) }}
        >
          <ComboInput
            aria-label="Specialization"
            placeholder="e.g. Backend"
            value={spec}
            options={specOptions}
            onChange={setSpec}
            onCommit={commitSpec}
          />
        </div>
      </td>
      <td>
        <button
          type="button"
          className={"dep-btn" + (deps.length ? " has-deps" : "")}
          aria-label={`Edit dependencies for ${task.name}`}
          onClick={() => setDepsOpen(true)}
        >
          {deps.length ? (
            <>
              <Icon name="link" size={12} />
              <span className="dep-btn-name">
                {depNames[0] ?? `${deps.length} tasks`}
              </span>
              {depNames.length > 1 && (
                <span className="dep-btn-more">+{depNames.length - 1}</span>
              )}
            </>
          ) : (
            <>
              <Icon name="plus" size={12} />
              Add
            </>
          )}
        </button>
        <Modal
          open={depsOpen}
          onClose={() => setDepsOpen(false)}
          title={`Dependencies for "${task.name}"`}
        >
          <p className="muted dep-modal-hint">
            This task will wait until every checked task finishes. Tick an epic
            to select all its tasks, then untick the ones to leave out.
          </p>
          <DependencyPicker
            task={task}
            allEpics={allEpics}
            onChange={(ids) =>
              actions.setTaskDependencies(projectId, epicId, task.id, ids)
            }
          />
          <div className="dep-modal-actions">
            <Button variant="primary" onClick={() => setDepsOpen(false)}>
              Done
            </Button>
          </div>
        </Modal>
      </td>
      <td className="col-status">
        <Chip
          on={!task.excluded}
          onChange={() =>
            actions.toggleTaskExcluded(projectId, epicId, task.id)
          }
        />
      </td>
      <td>
        <IconButton
          danger
          label={`Delete task ${task.name}`}
          onClick={() => actions.deleteTask(projectId, epicId, task.id)}
        >
          <Icon name="trash" size={14} />
        </IconButton>
      </td>
    </tr>
  );
}
