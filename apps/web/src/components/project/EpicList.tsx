import { useEffect, useRef, useState } from "react";
import type { Project } from "@planner/core";
import { useAppStore } from "@planner/client-runtime";

import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { EpicCard } from "./EpicCard";
import "./project.css";

interface EpicListProps {
  project: Project;
}

export function EpicList({ project }: EpicListProps) {
  const { actions } = useAppStore();

  // Local UI state: which epics are collapsed (task table hidden). Not
  // persisted — collapsing is a viewing convenience, not part of the plan.
  // Epics start collapsed so the page opens as a compact overview; newly
  // added epics aren't in the set, so they appear expanded and ready to edit.
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(project.epics.map((e) => e.id)),
  );

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

  return (
    <section className="epic-list">
      <div className="section-head">
        <h2 className="section-title">Epics &amp; Tasks</h2>
        <span className="spacer" />
        {project.epics.length > 0 && (
          <Button small onClick={toggleAll}>
            {allCollapsed ? "Expand all" : "Collapse all"}
          </Button>
        )}
        <Button small onClick={() => actions.addEpic(project.id, "New epic")}>
          + Add epic
        </Button>
      </div>

      {project.epics.length > 0 ? (
        project.epics.map((epic, i) => (
          <EpicCard
            key={epic.id}
            projectId={project.id}
            epic={epic}
            isFirst={i === 0}
            isLast={i === project.epics.length - 1}
            collapsed={collapsed.has(epic.id)}
            onToggleCollapse={() => toggleEpic(epic.id)}
          />
        ))
      ) : (
        <EmptyState
          title="No epics yet"
          message="Add an epic to start breaking this project down into tasks."
        />
      )}
    </section>
  );
}
