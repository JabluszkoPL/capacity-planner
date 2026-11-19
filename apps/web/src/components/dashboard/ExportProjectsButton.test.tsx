import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AppState, Project } from "@planner/core";
import { AppStoreProvider } from "@planner/client-runtime";
import { ToastProvider, ToastHost } from "../ui/Toast";
import { ExportProjectsButton, exportSelection } from "./ExportProjectsButton";

const download = vi.hoisted(() => vi.fn());
vi.mock("../../lib/download", () => ({ downloadStateJson: download }));

function project(id: string, name: string, teamId: string): Project {
  return {
    id,
    name,
    startDate: "2026-09-01",
    plan: null,
    planViewMode: "task",
    epics: [],
    teamInclusions: [{ teamId }],
  };
}

function state(): AppState {
  return {
    projects: [
      project("p1", "Alpha", "t-a"),
      project("p2", "Beta", "t-b"),
      project("p3", "Gamma", "t-a"),
    ],
    teams: [
      { id: "t-a", name: "A", members: [], offDays: {} },
      { id: "t-b", name: "B", members: [], offDays: {} },
      { id: "t-unused", name: "Unused", members: [], offDays: {} },
    ],
  };
}

function renderExport(initial: AppState) {
  return render(
    <ToastProvider>
      <AppStoreProvider initial={initial}>
        <ExportProjectsButton />
        <ToastHost />
      </AppStoreProvider>
    </ToastProvider>,
  );
}

describe("ExportProjectsButton", () => {
  beforeEach(() => {
    localStorage.clear();
    download.mockReset();
  });

  it("is disabled when there are no projects", () => {
    renderExport({ projects: [], teams: [] });
    expect(screen.getByRole("button", { name: "Export…" })).toBeDisabled();
  });

  it("exports every project as a full backup by default", async () => {
    const user = userEvent.setup();
    renderExport(state());

    await user.click(screen.getByRole("button", { name: "Export…" }));
    expect(
      screen.getByRole("dialog", { name: "Export projects" }),
    ).toBeVisible();
    expect(screen.getByText("3 of 3 selected")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Export 3 projects" }));

    expect(download).toHaveBeenCalledTimes(1);
    const [out, filename] = download.mock.calls[0] as [AppState, string];
    expect(out.projects.map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
    // Full backup: the team no project uses comes along.
    expect(out.teams.map((t) => t.id)).toContain("t-unused");
    expect(filename).toMatch(/^planner-export-\d{4}-\d{2}-\d{2}\.json$/);
    expect(await screen.findByText("Exported 3 projects")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("exports only the ticked projects and the teams they use", async () => {
    const user = userEvent.setup();
    renderExport(state());

    await user.click(screen.getByRole("button", { name: "Export…" }));
    await user.click(screen.getByLabelText("Beta"));
    await user.click(screen.getByRole("button", { name: "Export 2 projects" }));

    const [out] = download.mock.calls[0] as [AppState, string];
    expect(out.projects.map((p) => p.name)).toEqual(["Alpha", "Gamma"]);
    expect(out.teams.map((t) => t.id)).toEqual(["t-a"]);
  });

  it("names a single-project file after the project", async () => {
    const user = userEvent.setup();
    renderExport(state());

    await user.click(screen.getByRole("button", { name: "Export…" }));
    await user.click(screen.getByRole("button", { name: "Select none" }));
    expect(
      screen.getByRole("button", { name: "Export 0 projects" }),
    ).toBeDisabled();
    await user.click(screen.getByLabelText("Gamma"));
    await user.click(screen.getByRole("button", { name: "Export 1 project" }));

    const [out, filename] = download.mock.calls[0] as [AppState, string];
    expect(out.projects.map((p) => p.id)).toEqual(["p3"]);
    expect(filename).toMatch(/^gamma-\d{4}-\d{2}-\d{2}\.json$/);
  });

  it("Escape closes without exporting", async () => {
    const user = userEvent.setup();
    renderExport(state());

    await user.click(screen.getByRole("button", { name: "Export…" }));
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(download).not.toHaveBeenCalled();
  });
});

describe("exportSelection", () => {
  it("returns the whole state when every project is selected", () => {
    const s = state();
    expect(exportSelection(s, new Set(["p1", "p2", "p3"]))).toBe(s);
  });
});
