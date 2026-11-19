import { useEffect, useState, type KeyboardEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { useAppStore } from "@planner/client-runtime";
import { projectStats } from "../components/dashboard/ProjectCard";
import { EpicList } from "../components/project/EpicList";
import { PasteImportModal } from "../components/project/PasteImportModal";
import { HelpersPanel } from "../components/project/HelpersPanel";
import { TeamsPanel } from "../components/project/TeamsPanel";
import { MemberStartPanel } from "../components/project/MemberStartPanel";
import { RunPlanPanel } from "../components/schedule/RunPlanPanel";
import { Button } from "../components/ui/Button";
import { TITLE_COLORS, planFilenameStem, projectExport } from "@planner/core";
import { downloadStateJson } from "../lib/download";
import "../components/project/project.css";

/**
 * Project detail page container.
 *
 * Scaffolding introduced by T06 to host the epic/task editor. Later tasks
 * extend this same page:
 *  - T07 adds the "Paste from Sheets" import button + modal
 *  - T10 adds the "Run Plan" section and schedule visualization
 */
export function ProjectDetail() {
  const { id } = useParams();
  const { state, actions } = useAppStore();
  const project = state.projects.find((p) => p.id === id);

  const [name, setName] = useState(project?.name ?? "");
  const [pasteOpen, setPasteOpen] = useState(false);
  useEffect(() => {
    if (project) setName(project.name);
  }, [project?.name, project]);

  if (!project) {
    return (
      <main className="page">
        <div className="detail-topbar">
          <Link to="/" className="back-link">
            ← All Projects
          </Link>
        </div>
        <p className="muted">
          That project doesn't exist (it may have been deleted).
        </p>
      </main>
    );
  }

  const stats = projectStats(project);

  const commitName = () => {
    const next = name.trim();
    if (next && next !== project.name) actions.renameProject(project.id, next);
    else if (!next) setName(project.name);
  };
  const onNameKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.currentTarget.blur();
    }
  };

  return (
    <main className="page">
      <div className="detail-topbar">
        <Link to="/" className="back-link">
          ← All Projects
        </Link>
      </div>

      <div className="card">
        <div className="project-headline">
          <input
            type="text"
            className="project-name-input"
            aria-label="Project name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            onKeyDown={onNameKey}
            style={
              project.titleColor ? { color: project.titleColor } : undefined
            }
          />
          <div className="field">
            <label htmlFor="pd-start">Start date</label>
            <input
              id="pd-start"
              type="date"
              value={project.startDate}
              onChange={(e) =>
                actions.setProjectStartDate(project.id, e.target.value)
              }
            />
          </div>
          <span className="project-summary">
            {stats.epics} epics · {stats.tasks} tasks · {stats.activeDays}d
            planned
          </span>
        </div>

        <div className="title-color-row" role="group" aria-label="Title color">
          <span className="title-color-label">Title color</span>
          {TITLE_COLORS.map((c) => {
            const active =
              (project.titleColor ?? null) === c.value ||
              (!project.titleColor && c.value === null);
            return (
              <button
                key={c.label}
                type="button"
                className={"title-swatch" + (active ? " active" : "")}
                title={c.label}
                aria-label={c.label}
                aria-pressed={active}
                onClick={() =>
                  actions.setProjectTitleColor(project.id, c.value)
                }
                style={
                  c.value
                    ? { background: c.value }
                    : { background: "var(--bg)" }
                }
              >
                {c.value === null ? "∅" : ""}
              </button>
            );
          })}
        </div>

        <div className="field project-note-field">
          <label htmlFor="pd-note">Comment</label>
          <textarea
            id="pd-note"
            className="project-note-input"
            rows={2}
            placeholder="e.g. This is the best option · Low risk · Not real"
            value={project.note ?? ""}
            onChange={(e) => actions.setProjectNote(project.id, e.target.value)}
          />
        </div>
      </div>

      <div className="detail-toolbar">
        <Button variant="primary" small onClick={() => setPasteOpen(true)}>
          📋 Paste from Sheets
        </Button>
        <Button
          small
          onClick={() =>
            downloadStateJson(
              projectExport(state, project.id),
              `${planFilenameStem(project)}.json`,
            )
          }
        >
          Export project
        </Button>
      </div>

      <EpicList project={project} />

      <TeamsPanel project={project} />

      <MemberStartPanel project={project} />

      <HelpersPanel project={project} />

      <RunPlanPanel project={project} />

      <PasteImportModal
        open={pasteOpen}
        onClose={() => setPasteOpen(false)}
        project={project}
      />
    </main>
  );
}
