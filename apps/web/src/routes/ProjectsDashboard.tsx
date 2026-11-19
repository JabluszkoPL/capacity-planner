import { useLayoutEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAppStore } from "@planner/client-runtime";
import { useConfirm } from "../components/ui/ConfirmDialog";
import { useToast } from "../components/ui/Toast";
import { EmptyState } from "../components/ui/EmptyState";
import { NewProjectForm } from "../components/dashboard/NewProjectForm";
import { ProjectCard } from "../components/dashboard/ProjectCard";
import { ImportProjectsButton } from "../components/dashboard/ImportProjectsButton";
import { ExportProjectsButton } from "../components/dashboard/ExportProjectsButton";
import { Button } from "../components/ui/Button";
import { JiraImportModal } from "../components/tracking/JiraImportModal";
import "../components/dashboard/dashboard.css";

// Persists across route navigations because the router stays mounted, so
// returning from a project restores the scroll position we were at before.
let savedScrollY = 0;

export function ProjectsDashboard() {
  const { state, actions } = useAppStore();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const toast = useToast();
  const [jiraOpen, setJiraOpen] = useState(false);

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
    navigate(`/project/${id}`);
  };

  const copyProject = (id: string) => {
    actions.copyProject(id);
    toast("Project copied");
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

  return (
    <main className="page">
      <div className="page-title-row">
        <h1 className="page-title">Projects</h1>
        <div className="page-title-actions">
          <Button onClick={() => setJiraOpen(true)}>
            From Jira initiative
          </Button>
          <ImportProjectsButton />
          <ExportProjectsButton />
        </div>
      </div>
      <JiraImportModal open={jiraOpen} onClose={() => setJiraOpen(false)} />
      <NewProjectForm onCreate={createProject} />

      {state.projects.length === 0 ? (
        <EmptyState
          title="No projects yet"
          message="Create your first project above to start planning."
        />
      ) : (
        <div className="project-grid">
          {state.projects.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              teams={state.teams}
              onOpen={openProject}
              onCopy={copyProject}
              onDelete={deleteProject}
            />
          ))}
        </div>
      )}
    </main>
  );
}
