import { useLayoutEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAppStore } from "@planner/client-runtime";
import { includedTeams, planFilenameStem } from "@planner/core";
import { useConfirm } from "../components/ui/ConfirmDialog";
import { useToast } from "../components/ui/Toast";
import {
  Button,
  EmptyState,
  Icon,
  Modal,
  Page,
  PageHeader,
} from "../components/ui";
import { NewProjectForm } from "../components/dashboard/NewProjectForm";
import { ProjectCard } from "../components/dashboard/ProjectCard";
import { ImportProjectsButton } from "../components/dashboard/ImportProjectsButton";
import {
  ExportProjectsButton,
  exportSelection,
} from "../components/dashboard/ExportProjectsButton";
import { JiraImportModal } from "../components/tracking/JiraImportModal";
import { downloadStateJson } from "../lib/download";
import "../components/dashboard/dashboard.css";

// Persists across route navigations because the router stays mounted, so
// returning from a project restores the scroll position we were at before.
let savedScrollY = 0;

/** Filter value meaning "don't filter by team". */
const ALL_TEAMS = "";

export function ProjectsDashboard() {
  const { state, actions } = useAppStore();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const toast = useToast();
  const [jiraOpen, setJiraOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [teamId, setTeamId] = useState(ALL_TEAMS);

  useLayoutEffect(() => {
    window.scrollTo(0, savedScrollY);
    const onScroll = () => {
      savedScrollY = window.scrollY;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const openProject = (id: string) => navigate(`/project/${id}`);

  const createProject = (name: string, startDate: string) => {
    const id = actions.createProject(name, startDate);
    setNewOpen(false);
    navigate(`/project/${id}`);
  };

  const copyProject = (id: string) => {
    actions.copyProject(id);
    toast("Project copied");
  };

  // The same file the Export dialog writes for a one-project selection.
  const exportProject = (id: string) => {
    const project = state.projects.find((p) => p.id === id);
    if (!project) return;
    downloadStateJson(
      exportSelection(state, new Set([id])),
      `${planFilenameStem(project)}.json`,
    );
    toast(`Exported "${project.name}"`);
  };

  const deleteProject = async (id: string) => {
    const project = state.projects.find((p) => p.id === id);
    if (!project) return;
    const ok = await confirm({
      title: "Delete project",
      message: `Delete "${project.name}"? This can't be undone.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (ok) actions.deleteProject(id);
  };

  // A team picked earlier may have been deleted since; treat it as "all".
  const teamFilter = state.teams.some((t) => t.id === teamId)
    ? teamId
    : ALL_TEAMS;
  const needle = query.trim().toLowerCase();
  const filtered = state.projects.filter(
    (p) =>
      (!needle || p.name.toLowerCase().includes(needle)) &&
      (teamFilter === ALL_TEAMS ||
        includedTeams(p, state.teams).some((t) => t.id === teamFilter)),
  );
  const filtering = needle !== "" || teamFilter !== ALL_TEAMS;

  const clearFilters = () => {
    setQuery("");
    setTeamId(ALL_TEAMS);
  };

  return (
    <Page>
      <PageHeader
        title="Projects"
        actions={
          <>
            <Button icon="jira" onClick={() => setJiraOpen(true)}>
              From Jira initiative
            </Button>
            <ImportProjectsButton />
            <ExportProjectsButton />
            <Button
              variant="primary"
              icon="plus"
              onClick={() => setNewOpen(true)}
            >
              New project
            </Button>
          </>
        }
      />
      <JiraImportModal open={jiraOpen} onClose={() => setJiraOpen(false)} />
      <Modal
        open={newOpen}
        onClose={() => setNewOpen(false)}
        title="New project"
        subtitle="Name it and pick a start date; add epics, tasks and teams next."
      >
        <NewProjectForm
          onCreate={createProject}
          onCancel={() => setNewOpen(false)}
        />
      </Modal>

      {state.projects.length === 0 ? (
        <EmptyState
          title="No projects yet"
          message="Create your first project to start planning."
        >
          <Button
            variant="primary"
            icon="plus"
            onClick={() => setNewOpen(true)}
          >
            Create a project
          </Button>
        </EmptyState>
      ) : (
        <>
          <div className="dashboard-filters" role="search">
            <label className="dashboard-search">
              <Icon name="search" size={15} />
              <input
                type="search"
                value={query}
                placeholder="Search projects…"
                aria-label="Search projects"
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            {state.teams.length > 1 && (
              <select
                aria-label="Filter by team"
                value={teamFilter}
                onChange={(e) => setTeamId(e.target.value)}
              >
                <option value={ALL_TEAMS}>All teams</option>
                {state.teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            )}
            <span className="spacer" />
            <span className="muted" aria-live="polite">
              {filtering
                ? `${filtered.length} of ${state.projects.length} projects`
                : state.projects.length === 1
                  ? "1 project"
                  : `${state.projects.length} projects`}
            </span>
          </div>

          {filtered.length === 0 ? (
            <EmptyState
              compact
              title="No matching projects"
              message="Nothing matches this search or team."
            >
              <Button small onClick={clearFilters}>
                Clear filters
              </Button>
            </EmptyState>
          ) : (
            <div className="project-grid">
              {filtered.map((project) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  teams={state.teams}
                  onOpen={openProject}
                  onCopy={copyProject}
                  onExport={exportProject}
                  onDelete={deleteProject}
                />
              ))}
            </div>
          )}
        </>
      )}
    </Page>
  );
}
