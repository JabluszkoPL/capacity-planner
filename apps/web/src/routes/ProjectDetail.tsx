import { useEffect, useState, type KeyboardEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { useAppStore } from "@planner/client-runtime";
import {
  type AppState,
  type Project,
  TITLE_COLORS,
  fromISO,
  includedMembers,
  includedTeams,
  planFilenameStem,
  projectExport,
} from "@planner/core";
import { completesOn, projectStats } from "../components/dashboard/ProjectCard";
import { EpicList } from "../components/project/EpicList";
import { PasteImportModal } from "../components/project/PasteImportModal";
import { HelpersPanel } from "../components/project/HelpersPanel";
import { TeamsPanel } from "../components/project/TeamsPanel";
import { MemberStartPanel } from "../components/project/MemberStartPanel";
import { RunPlanPanel } from "../components/schedule/RunPlanPanel";
import {
  Button,
  EmptyState,
  Field,
  Icon,
  IconTile,
  Page,
  PageHeader,
  ViewTabs,
  Panel,
  StatRow,
  StatTile,
} from "../components/ui";
import { downloadStateJson } from "../lib/download";
import {
  PROJECT_VIEWS,
  useView,
  viewHref,
  type ProjectView,
} from "../lib/views";
import "../components/project/project.css";

/** "Dec 18, 2026" for an ISO date. */
function longDate(iso: string): string {
  return fromISO(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * The project page. A project is too much for one scrolling page, so it is
 * split into the views in `PROJECT_VIEWS` (the sidebar lists them, `?view=`
 * selects one): an overview, the epic/task editor, the people working it, the
 * plan, and the project's own settings. Every view shares the header.
 */
export function ProjectDetail() {
  const { id } = useParams();
  const { state, actions } = useAppStore();
  const [view] = useView(PROJECT_VIEWS);
  const project = state.projects.find((p) => p.id === id);

  const [name, setName] = useState(project?.name ?? "");
  const [pasteOpen, setPasteOpen] = useState(false);
  useEffect(() => {
    if (project) setName(project.name);
  }, [project?.name, project]);

  if (!project) {
    return (
      <Page>
        <PageHeader title="Project not found" />
        <EmptyState
          title="That project doesn't exist"
          message="It may have been deleted, or the link is out of date."
        >
          <Link to="/" className="btn">
            All projects
          </Link>
        </EmptyState>
      </Page>
    );
  }

  const base = `/project/${project.id}`;
  const href = (v: ProjectView) => viewHref(base, v, PROJECT_VIEWS[0].id);
  const finish = completesOn(project);

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

  const title =
    view === "overview" ? (
      <input
        type="text"
        className="page-title-input"
        aria-label="Project name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={commitName}
        onKeyDown={onNameKey}
      />
    ) : (
      <h1 className="page-title">{project.name}</h1>
    );

  return (
    <Page width={view === "plan" ? "wide" : "default"}>
      <PageHeader
        eyebrow={
          <nav aria-label="Breadcrumb" className="pd-crumbs">
            <Link to="/">Projects</Link>
            <Icon name="chevronRight" size={12} />
            <span aria-current="page">{project.name}</span>
          </nav>
        }
        leading={
          <IconTile icon="folder" color={project.titleColor} size="lg" />
        }
        title={title}
        subtitle={
          <>
            <span>Starts {longDate(project.startDate)}</span>
            <span aria-hidden="true">·</span>
            <span>
              {finish
                ? `Planned finish ${longDate(finish)}`
                : "Not planned yet"}
            </span>
          </>
        }
      >
        <ViewTabs
          base={`/project/${project.id}`}
          views={PROJECT_VIEWS}
          current={view}
          label="Project views"
        />
      </PageHeader>

      {view === "overview" && (
        <OverviewView project={project} state={state} href={href} />
      )}

      {view === "tasks" && (
        <>
          <EpicList project={project} onPaste={() => setPasteOpen(true)} />
          <PasteImportModal
            open={pasteOpen}
            onClose={() => setPasteOpen(false)}
            project={project}
          />
        </>
      )}

      {view === "people" && (
        <div className="stack">
          <TeamsPanel project={project} />
          <MemberStartPanel project={project} />
          <HelpersPanel project={project} />
        </div>
      )}

      {view === "plan" && <RunPlanPanel project={project} />}

      {view === "settings" && <SettingsView project={project} state={state} />}
    </Page>
  );
}

function OverviewView({
  project,
  state,
  href,
}: {
  project: Project;
  state: AppState;
  href: (v: ProjectView) => string;
}) {
  const stats = projectStats(project);
  const finish = completesOn(project);
  const teams = includedTeams(project, state.teams);
  const people = includedMembers(project, state.teams).length;
  const helpers = project.helpers?.length ?? 0;
  const skipped = project.epics.reduce(
    (n, e) => n + e.tasks.filter((t) => t.excluded).length,
    0,
  );

  return (
    <>
      <StatRow>
        <StatTile
          icon={<Icon name="layers" size={18} />}
          label="Epics"
          value={stats.epics}
        />
        <StatTile
          icon={<Icon name="list" size={18} />}
          label="Tasks"
          value={stats.tasks}
          hint={skipped > 0 ? `${skipped} skipped` : undefined}
        />
        <StatTile
          icon={<Icon name="clipboard" size={18} />}
          label="Estimate"
          value={`${stats.activeDays} days`}
          hint="planned work"
        />
        <StatTile
          icon={<Icon name="flag" size={18} />}
          label="Planned finish"
          value={finish ? longDate(finish) : "Not planned yet"}
          tone={finish ? "accent" : "neutral"}
        />
      </StatRow>

      <div className="grid-2">
        <Panel title="Project summary">
          <dl className="pd-summary">
            <dt>Start date</dt>
            <dd>{longDate(project.startDate)}</dd>
            <dt>Teams</dt>
            <dd>
              {teams.length > 0 ? (
                teams.map((t) => t.name).join(", ")
              ) : (
                <span className="muted">No teams yet</span>
              )}
            </dd>
            <dt>People</dt>
            <dd>
              {people} {people === 1 ? "person" : "people"}
              {helpers > 0 && ` + ${helpers} helper${helpers === 1 ? "" : "s"}`}
            </dd>
            <dt>Note</dt>
            <dd>
              {project.note ? (
                <span className="pd-note">{project.note}</span>
              ) : (
                <span className="muted">No note</span>
              )}
            </dd>
          </dl>
        </Panel>

        <Panel
          title="Epics"
          flush
          actions={
            <Link to={href("tasks")} className="btn small ghost">
              Edit
            </Link>
          }
        >
          {project.epics.length === 0 ? (
            <EmptyState
              compact
              title="No epics yet"
              message="Add epics and tasks to start planning."
            />
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Epic</th>
                  <th className="num">Tasks</th>
                  <th className="num">Days</th>
                </tr>
              </thead>
              <tbody>
                {project.epics.map((e) => {
                  const active = e.tasks.filter((t) => !t.excluded);
                  const days = active.reduce(
                    (s, t) => s + (Number(t.estimateDays) || 0),
                    0,
                  );
                  return (
                    <tr key={e.id}>
                      <td>{e.name}</td>
                      <td className="num">{active.length}</td>
                      <td className="num">{days}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td>Total</td>
                  <td className="num">{stats.tasks - skipped}</td>
                  <td className="num">{stats.activeDays}</td>
                </tr>
              </tfoot>
            </table>
          )}
        </Panel>
      </div>
    </>
  );
}

function SettingsView({
  project,
  state,
}: {
  project: Project;
  state: AppState;
}) {
  const { actions } = useAppStore();
  const [name, setName] = useState(project.name);
  useEffect(() => setName(project.name), [project.name]);

  const commitName = () => {
    const next = name.trim();
    if (next && next !== project.name) actions.renameProject(project.id, next);
    else if (!next) setName(project.name);
  };

  return (
    <div className="stack pd-settings">
      <Panel
        title="General"
        subtitle="The project's name and when work starts."
      >
        <div className="grid-2">
          <Field label="Name" htmlFor="pd-name">
            <input
              id="pd-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  e.currentTarget.blur();
                }
              }}
            />
          </Field>
          <Field label="Start date" htmlFor="pd-start">
            <input
              id="pd-start"
              type="date"
              value={project.startDate}
              onChange={(e) =>
                actions.setProjectStartDate(project.id, e.target.value)
              }
            />
          </Field>
        </div>
      </Panel>

      <Panel
        title="Appearance"
        subtitle="A project accent tags this project as an option at a glance."
      >
        <div className="pd-accent">
          <div>
            <div className="pd-accent-label" id="pd-accent-label">
              Project accent
            </div>
            <div
              className="title-color-row"
              role="group"
              aria-labelledby="pd-accent-label"
            >
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
                      c.value ? { ["--swatch" as string]: c.value } : undefined
                    }
                  >
                    {active ? (
                      <Icon name="check" size={14} />
                    ) : c.value === null ? (
                      "∅"
                    ) : null}
                  </button>
                );
              })}
            </div>
            <div className="field-hint">
              {TITLE_COLORS.find(
                (c) => c.value === (project.titleColor || null),
              )?.label ?? "Custom"}
            </div>
          </div>
          <div className="pd-accent-preview" aria-hidden="true">
            <IconTile icon="folder" color={project.titleColor} />
            <span
              className="pd-accent-name"
              style={
                project.titleColor ? { color: project.titleColor } : undefined
              }
            >
              {project.name}
            </span>
          </div>
        </div>
      </Panel>

      <Panel title="Note" subtitle="A short comment shown on the project card.">
        <Field label="Comment" htmlFor="pd-note">
          <textarea
            id="pd-note"
            className="project-note-input"
            rows={3}
            placeholder="e.g. This is the best option · Low risk · Not real"
            value={project.note ?? ""}
            onChange={(e) => actions.setProjectNote(project.id, e.target.value)}
          />
        </Field>
      </Panel>

      <Panel title="Export">
        <div className="pd-export">
          <p className="muted">
            Download this project with the teams it plans with and the trackers
            that use it, as a JSON file Import can read back.
          </p>
          <Button
            icon="download"
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
      </Panel>
    </div>
  );
}
