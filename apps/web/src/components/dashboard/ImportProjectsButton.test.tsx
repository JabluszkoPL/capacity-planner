import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AppState } from "@planner/core";
import { AppStoreProvider, useAppStore } from "@planner/client-runtime";
import { ToastProvider, ToastHost } from "../ui/Toast";
import { ImportProjectsButton } from "./ImportProjectsButton";
import exportFixture from "./__fixtures__/old-planner-export.json";

/**
 * The fixture is a genuine export produced by the old browser-only Planner's
 * own export path, not a hand-written shape — that is the whole point of the
 * test: it proves an old-Planner file lands here intact.
 */
const OLD_PLANNER_JSON = JSON.stringify(exportFixture);

function ProjectList() {
  const { state } = useAppStore();
  return (
    <ul data-testid="projects">
      {state.projects.map((p) => (
        <li key={p.id}>{p.name}</li>
      ))}
    </ul>
  );
}

function TeamList() {
  const { state } = useAppStore();
  return (
    <ul data-testid="teams">
      {state.teams.map((t) => (
        <li key={t.id}>{t.name}</li>
      ))}
    </ul>
  );
}

function renderImport(initial: AppState) {
  return render(
    <ToastProvider>
      <AppStoreProvider initial={initial}>
        <ImportProjectsButton />
        <ProjectList />
        <TeamList />
        <ToastHost />
      </AppStoreProvider>
    </ToastProvider>,
  );
}

function file(contents: string, name = "export.json") {
  return new File([contents], name, { type: "application/json" });
}

/** The hidden <input type="file"> the button clicks on the user's behalf. */
function fileInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("file input not rendered");
  return input;
}

function existing(): AppState {
  return {
    projects: [
      {
        id: "local1",
        name: "New T3 draft",
        startDate: "2026-09-01",
        plan: null,
        planViewMode: "person",
        epics: [],
      },
    ],
    teams: [{ id: "localteam", name: "T3 Team", members: [], offDays: {} }],
  };
}

describe("ImportProjectsButton", () => {
  beforeEach(() => localStorage.clear());

  it("adds the old Planner's project without removing the existing draft", async () => {
    const user = userEvent.setup();
    renderImport(existing());

    await user.upload(fileInput(), file(OLD_PLANNER_JSON));

    await waitFor(() =>
      expect(screen.getByText("Sample Project")).toBeInTheDocument(),
    );
    expect(screen.getByText("New T3 draft")).toBeInTheDocument();
  });

  it("brings the imported project's teams along", async () => {
    const user = userEvent.setup();
    renderImport(existing());

    await user.upload(fileInput(), file(OLD_PLANNER_JSON));

    await waitFor(() =>
      expect(screen.getByText("Core Team")).toBeInTheDocument(),
    );
    expect(screen.getByText("Platform Team")).toBeInTheDocument();
    expect(screen.getByText("T3 Team")).toBeInTheDocument();
  });

  it("reports what it imported", async () => {
    const user = userEvent.setup();
    renderImport(existing());

    await user.upload(fileInput(), file(OLD_PLANNER_JSON));

    expect(await screen.findByText(/Imported 1 project/)).toBeInTheDocument();
  });

  it("importing the same file twice keeps both copies, distinctly named", async () => {
    const user = userEvent.setup();
    renderImport(existing());

    await user.upload(fileInput(), file(OLD_PLANNER_JSON));
    await waitFor(() =>
      expect(screen.getByText("Sample Project")).toBeInTheDocument(),
    );
    await user.upload(fileInput(), file(OLD_PLANNER_JSON));

    await waitFor(() =>
      expect(screen.getByText("Sample Project (imported)")).toBeInTheDocument(),
    );
    expect(screen.getByText("Sample Project")).toBeInTheDocument();
  });

  it("surfaces a clear message for a file that isn't a Planner export", async () => {
    const user = userEvent.setup();
    renderImport(existing());

    await user.upload(fileInput(), file('{"nope":1}'));

    expect(await screen.findByText(/Planner export/i)).toBeInTheDocument();
    expect(screen.getByText("New T3 draft")).toBeInTheDocument();
  });

  it("leaves state alone when nothing in the file is new", async () => {
    const user = userEvent.setup();
    renderImport(existing());

    await user.upload(
      fileInput(),
      file(JSON.stringify({ projects: [], teams: existing().teams })),
    );

    expect(
      await screen.findByText(/nothing new to import/i),
    ).toBeInTheDocument();
    expect(screen.getByTestId("projects").children).toHaveLength(1);
    expect(screen.getByTestId("teams").children).toHaveLength(1);
  });

  // The old Planner's "Export everything" writes every team, including ones no
  // project uses, so the whole roster comes across.
  it("keeps a team from a full backup that no project uses", async () => {
    const user = userEvent.setup();
    renderImport(existing());
    const backup = {
      ...exportFixture,
      teams: [
        ...exportFixture.teams,
        { id: "spare", name: "Spare Team", members: [], offDays: {} },
      ],
    };

    await user.upload(fileInput(), file(JSON.stringify(backup)));

    await waitFor(() =>
      expect(screen.getByText("Spare Team")).toBeInTheDocument(),
    );
    expect(screen.getByText("Sample Project")).toBeInTheDocument();
  });

  it("imports a file that only has new teams", async () => {
    const user = userEvent.setup();
    renderImport(existing());

    await user.upload(
      fileInput(),
      file(JSON.stringify({ projects: [], teams: exportFixture.teams })),
    );

    expect(
      await screen.findByText(/^Imported 2 new teams/),
    ).toBeInTheDocument();
    expect(screen.getByText("Core Team")).toBeInTheDocument();
    expect(screen.getByTestId("projects").children).toHaveLength(1);
  });
});
