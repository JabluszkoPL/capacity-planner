import { useEffect, useRef, useState } from "react";
import type { Project } from "@planner/core";
import { useAppStore } from "@planner/client-runtime";

import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { Panel } from "../ui/Panel";
import { EpicCard } from "./EpicCard";
import "./project.css";

interface EpicListProps {
  project: Project;
  /** Opens the paste-from-Sheets import; the toolbar shows a button for it. */
  onPaste?: () => void;
}

/**
 * The epic/task editor: a toolbar, then each epic as a collapsible group with
 * its tasks in a table underneath.
 */
export function EpicList({ project, onPaste }: EpicListProps) {
  const { actions } = useAppStore();

  // Local UI state: which epics are collapsed (task table hidden). Not
  // persisted — collapsing is a viewing convenience, not part of the plan.
  // Epics start expanded: this list has a view of its own, so there is room
  // to show every task. "Collapse all" folds them for an overview.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  // Auto-expand an epic when tasks appear in it while it's collapsed. A
  // collapsed epic hides its task table, so the only way it can gain tasks is
  // an import (paste) — and imported tasks should be visible immediately.
  const taskCounts = useRef(
    new Map(project.epics.map((e) => [e.id, e.tasks.length])),
  );
  useEffect(() => {
    const grown = project.epics
      .filter((e) => {
        const before = taskCounts.current.get(e.id);
        return before !== undefined && e.tasks.length > before;
      })
      .map((e) => e.id);
    taskCounts.current = new Map(
      project.epics.map((e) => [e.id, e.tasks.length]),
    );
    if (grown.length === 0) return;
    setCollapsed((prev) => {
      if (!grown.some((id) => prev.has(id))) return prev;
      const next = new Set(prev);
      for (const id of grown) next.delete(id);
      return next;
    });
  }, [project.epics]);

  const epicIds = project.epics.map((e) => e.id);
  const allCollapsed =
    epicIds.length > 0 && epicIds.every((id) => collapsed.has(id));

  const toggleEpic = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleAll = () =>
    setCollapsed(allCollapsed ? new Set() : new Set(epicIds));

  const taskCount = project.epics.reduce((n, e) => n + e.tasks.length, 0);
  const totalDays = project.epics.reduce(
    (sum, e) =>
      sum +
      e.tasks
        .filter((t) => !t.excluded)
        .reduce((d, t) => d + (Number(t.estimateDays) || 0), 0),
    0,
  );

  return (
    <Panel
      className="epic-list"
      flush
      title="Epics & Tasks"
      subtitle={
        project.epics.length > 0
          ? `${project.epics.length} epic${project.epics.length === 1 ? "" : "s"} · ${taskCount} task${taskCount === 1 ? "" : "s"} · ${totalDays} days planned`
          : undefined
      }
    >
      <div className="epic-toolbar toolbar">
        <Button
          variant="primary"
          small
          icon="plus"
          onClick={() => actions.addEpic(project.id, "New epic")}
        >
          Add epic
        </Button>
        {onPaste && (
          <Button small icon="clipboard" onClick={onPaste}>
            Paste from Sheets
          </Button>
        )}
        <span className="spacer" />
        {project.epics.length > 0 && (
          <Button
            small
            variant="ghost"
            icon={allCollapsed ? "chevronDown" : "chevronRight"}
            onClick={toggleAll}
          >
            {allCollapsed ? "Expand all" : "Collapse all"}
          </Button>
        )}
      </div>

      {project.epics.length > 0 ? (
        <div className="epic-groups">
          {project.epics.map((epic, i) => (
            <EpicCard
              key={epic.id}
              projectId={project.id}
              epic={epic}
              isFirst={i === 0}
              isLast={i === project.epics.length - 1}
              collapsed={collapsed.has(epic.id)}
              onToggleCollapse={() => toggleEpic(epic.id)}
            />
          ))}
        </div>
      ) : (
        <EmptyState
          title="No epics yet"
          message="Add an epic to start breaking this project down into tasks."
        />
      )}
    </Panel>
  );
}
