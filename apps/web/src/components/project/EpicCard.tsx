import { useEffect, useState, type KeyboardEvent } from "react";
import { type Epic, includedMembers, colorFor } from "@planner/core";
import { useAppStore } from "@planner/client-runtime";

import { useConfirm } from "../ui/ConfirmDialog";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";

import { TaskRow } from "./TaskRow";

interface EpicCardProps {
  projectId: string;
  epic: Epic;
  isFirst: boolean;
  isLast: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

export function EpicCard({
  projectId,
  epic,
  isFirst,
  isLast,
  collapsed,
  onToggleCollapse,
}: EpicCardProps) {
  const { state, actions } = useAppStore();
  const confirm = useConfirm();

  const project = state.projects.find((p) => p.id === projectId);
  const members = project ? includedMembers(project, state.teams) : [];
  const assignedIds = project?.epicAssignments?.[epic.id] ?? [];
  const allEpics = project?.epics ?? [];
  const otherEpics = allEpics.filter((e) => e.id !== epic.id);
  const epicDeps = epic.dependsOn ?? [];

  const [name, setName] = useState(epic.name);
  useEffect(() => setName(epic.name), [epic.name]);

  // Drag-and-drop reordering of tasks. `dragIndex` is the row being dragged,
  // `overIndex` is the row it's currently hovering over.
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  const commitDrop = () => {
    if (dragIndex !== null && overIndex !== null && dragIndex !== overIndex) {
      const task = epic.tasks[dragIndex];
      if (task) actions.moveTask(projectId, epic.id, task.id, overIndex);
    }
    setDragIndex(null);
    setOverIndex(null);
  };
  const cancelDrag = () => {
    setDragIndex(null);
    setOverIndex(null);
  };

  const commitName = () => {
    const next = name.trim();
    if (next && next !== epic.name)
      actions.renameEpic(projectId, epic.id, next);
    else if (!next) setName(epic.name); // don't allow a blank epic name
  };

  const activeTasks = epic.tasks.filter((t) => !t.excluded);
  const totalDays = activeTasks.reduce(
    (sum, t) => sum + (Number(t.estimateDays) || 0),
    0,
  );

  const onNameKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.currentTarget.blur();
    }
  };

  const handleDelete = async () => {
    const ok = await confirm({
      title: "Delete epic",
      message: `Delete epic "${epic.name}" and its ${epic.tasks.length} task(s)?`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (ok) actions.deleteEpic(projectId, epic.id);
  };

  return (
    <div className="epic-card">
      <div className="epic-header">
        <IconButton
          label={
            collapsed
              ? `Expand epic ${epic.name}`
              : `Collapse epic ${epic.name}`
          }
          aria-expanded={!collapsed}
          onClick={onToggleCollapse}
        >
          {collapsed ? "▸" : "▾"}
        </IconButton>
        <div className="epic-order-btns">
          <IconButton
            label="Move epic up"
            disabled={isFirst}
            onClick={() => actions.reorderEpic(projectId, epic.id, -1)}
          >
            ▲
          </IconButton>
          <IconButton
            label="Move epic down"
            disabled={isLast}
            onClick={() => actions.reorderEpic(projectId, epic.id, 1)}
          >
            ▼
          </IconButton>
        </div>
        <input
          type="text"
          className="epic-name"
          aria-label="Epic name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={onNameKey}
        />
        <span className="epic-meta">
          {activeTasks.length} tasks · {totalDays}d
        </span>
        <Button
          small
          onClick={() =>
            actions.addTask(projectId, epic.id, {
              name: "New task",
              estimateDays: 1,
              specialization: "",
              excluded: false,
            })
          }
        >
          + Task
        </Button>
        <IconButton
          danger
          label={`Delete epic ${epic.name}`}
          onClick={handleDelete}
        >
          ✕
        </IconButton>
      </div>

      {!collapsed && members.length > 0 && (
        <div className="epic-assign">
          <span className="epic-assign-label">Assigned to:</span>
          <div className="epic-assign-chips">
            {members.map((m) => {
              const on = assignedIds.includes(m.id);
              return (
                <button
                  key={m.id}
                  type="button"
                  className={"assign-chip " + (on ? "on" : "off")}
                  aria-pressed={on}
                  aria-label={`${on ? "Unassign" : "Assign"} ${m.name} ${
                    on ? "from" : "to"
                  } epic ${epic.name}`}
                  onClick={() =>
                    actions.toggleEpicAssignment(projectId, epic.id, m.id)
                  }
                >
                  <span
                    className="swatch"
                    style={{ background: colorFor(m.specialization) }}
                    aria-hidden="true"
                  />
                  {m.name}
                </button>
              );
            })}
          </div>
          {assignedIds.length > 0 && (
            <span className="epic-assign-hint muted">
              starts here first — others can still help, and they won't sit idle
            </span>
          )}
        </div>
      )}

      {!collapsed && otherEpics.length > 0 && (
        <div className="epic-assign epic-deps">
          <span className="epic-assign-label">Depends on:</span>
          <div className="epic-assign-chips">
            {otherEpics.map((e) => {
              const on = epicDeps.includes(e.id);
              return (
                <button
                  key={e.id}
                  type="button"
                  className={"assign-chip " + (on ? "on" : "off")}
                  aria-pressed={on}
                  aria-label={`${on ? "Remove dependency on" : "Depend on"} epic ${e.name}`}
                  onClick={() =>
                    actions.toggleEpicDependency(projectId, epic.id, e.id)
                  }
                >
                  {e.name}
                </button>
              );
            })}
          </div>
          {epicDeps.length > 0 && (
            <span className="epic-assign-hint muted">
              waits until those epics finish
            </span>
          )}
        </div>
      )}

      {collapsed ? null : epic.tasks.length > 0 ? (
        <div className="task-table-scroll">
          <table className="task-table">
            <thead>
              <tr>
                <th className="col-order" />
                <th>Task</th>
                <th className="col-est">Est. (days)</th>
                <th className="col-spec">Specialization</th>
                <th className="col-deps">Depends on</th>
                <th className="col-status">Status</th>
                <th className="col-del" />
              </tr>
            </thead>
            <tbody>
              {epic.tasks.map((task, i) => (
                <TaskRow
                  key={task.id}
                  projectId={projectId}
                  epicId={epic.id}
                  task={task}
                  allEpics={allEpics}
                  isFirst={i === 0}
                  isLast={i === epic.tasks.length - 1}
                  index={i}
                  isDragging={dragIndex === i}
                  isDragOver={overIndex === i}
                  onDragStart={setDragIndex}
                  onDragOverRow={setOverIndex}
                  onDrop={commitDrop}
                  onDragEnd={cancelDrag}
                />
              ))}
            </tbody>
          </table>
          <div className="epic-add-task-row">
            <IconButton
              label="Add task"
              onClick={() =>
                actions.addTask(projectId, epic.id, {
                  name: "New task",
                  estimateDays: 1,
                  specialization: "",
                  excluded: false,
                })
              }
            >
              +
            </IconButton>
          </div>
        </div>
      ) : (
        <div className="epic-empty">
          No tasks yet. Click "+ Task" or paste from Sheets.
        </div>
      )}
    </div>
  );
}
