import { useId, useState } from "react";
import { useAppStore } from "@planner/client-runtime";
import {
  exportFilename,
  planFilenameStem,
  projectsExport,
  type AppState,
  type ID,
} from "@planner/core";
import { downloadStateJson } from "../../lib/download";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { useToast } from "../ui/Toast";

/**
 * What the export file holds for a given selection.
 *
 * Choosing every project exports the whole state, so the file is a full
 * backup: teams no project uses and trackers with no baseline project come
 * along too. A partial selection exports just those projects plus the teams
 * and trackers they need (see {@link projectsExport}). Either way it is an
 * ordinary `AppState`, so the Import button reads it back.
 */
export function exportSelection(state: AppState, selected: Set<ID>): AppState {
  const all = state.projects.every((p) => selected.has(p.id));
  return all ? state : projectsExport(state, selected);
}

/** Dashboard "Export…" — pick projects and download them as one JSON file. */
export function ExportProjectsButton() {
  const { state } = useAppStore();
  const toast = useToast();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<ID>>(new Set());

  const projects = state.projects;
  const allOn = projects.length > 0 && selected.size === projects.length;

  const openModal = () => {
    // Everything starts selected: "export all" is the common case.
    setSelected(new Set(projects.map((p) => p.id)));
    setOpen(true);
  };

  const toggle = (projectId: ID) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  const exportNow = () => {
    const picked = projects.filter((p) => selected.has(p.id));
    if (picked.length === 0) return;
    const filename =
      picked.length === 1
        ? `${planFilenameStem(picked[0])}.json`
        : exportFilename();
    downloadStateJson(exportSelection(state, selected), filename);
    setOpen(false);
    toast(
      picked.length === 1
        ? `Exported "${picked[0].name}"`
        : `Exported ${picked.length} projects`,
    );
  };

  return (
    <>
      <Button
        variant="ghost"
        icon="download"
        onClick={openModal}
        disabled={projects.length === 0}
      >
        Export…
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Export projects">
        <p className="modal-hint">
          Saves a JSON file that Import can read back, here or on another
          device. Each project brings its teams and Jira trackers with it; Jira
          credentials are never included.
          {allOn &&
            " With every project selected, the file is a full backup, including teams no project uses."}
        </p>
        <div className="export-select-row">
          <span className="muted" aria-live="polite">
            {selected.size} of {projects.length} selected
          </span>
          <span className="spacer" />
          <button
            type="button"
            className="export-toggle-all"
            onClick={() =>
              setSelected(
                allOn ? new Set() : new Set(projects.map((p) => p.id)),
              )
            }
          >
            {allOn ? "Select none" : "Select all"}
          </button>
        </div>
        <ul className="export-project-list">
          {projects.map((project) => {
            const boxId = `${id}-${project.id}`;
            return (
              <li key={project.id}>
                <input
                  id={boxId}
                  type="checkbox"
                  checked={selected.has(project.id)}
                  onChange={() => toggle(project.id)}
                />
                <label htmlFor={boxId}>{project.name}</label>
              </li>
            );
          })}
        </ul>
        <div className="modal-actions">
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            variant="primary"
            onClick={exportNow}
            disabled={selected.size === 0}
          >
            {selected.size === 1
              ? "Export 1 project"
              : `Export ${selected.size} projects`}
          </Button>
        </div>
      </Modal>
    </>
  );
}
