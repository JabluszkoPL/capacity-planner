// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import type { AppState } from "@planner/core";
import { AppStoreProvider, useAppStore } from "@planner/client-runtime";
import { ConfirmProvider } from "../components/ui/ConfirmDialog";
import { ToastProvider } from "../components/ui/Toast";
import { ProjectDetail } from "./ProjectDetail";

function state(): AppState {
  return {
    teams: [
      {
        id: "team",
        name: "Core Team",
        members: [{ id: "m1", name: "Anna", specialization: "Design" }],
        offDays: {},
      },
    ],
    projects: [
      {
        id: "p1",
        name: "Aurora Launch",
        startDate: "2026-11-23",
        plan: null,
        planViewMode: "person",
        note: "Low risk",
        epics: [
          {
            id: "e1",
            name: "Onboarding Flow",
            tasks: [
              {
                id: "t1",
                name: "Design screens",
                estimateDays: 5,
                specialization: "Design",
                excluded: false,
              },
              {
                id: "t2",
                name: "Signup form",
                estimateDays: 6,
                specialization: "Frontend",
                excluded: true,
              },
            ],
          },
        ],
      },
    ],
  };
}

function Probe() {
  const { state } = useAppStore();
  const p = state.projects[0];
  return (
    <div data-testid="probe">
      {p.name}|{p.titleColor ?? "none"}
    </div>
  );
}

function renderAt(path: string) {
  return render(
    <ToastProvider>
      <ConfirmProvider>
        <AppStoreProvider initial={state()}>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path="/project/:id" element={<ProjectDetail />} />
            </Routes>
          </MemoryRouter>
          <Probe />
        </AppStoreProvider>
      </ConfirmProvider>
    </ToastProvider>,
  );
}

describe("ProjectDetail", () => {
  beforeEach(() => localStorage.clear());

  it("opens on the overview: stats, summary and the epic table", () => {
    renderAt("/project/p1");
    expect(screen.getByText("Project summary")).toBeInTheDocument();
    expect(screen.getByText("Core Team")).toBeInTheDocument();
    expect(screen.getByText("Low risk")).toBeInTheDocument();
    // One epic row: one included task worth 5 days (the skipped one is out).
    const row = screen.getByRole("row", { name: /Onboarding Flow/ });
    expect(row).toHaveTextContent("Onboarding Flow15");
    expect(screen.getAllByText("Not planned yet").length).toBeGreaterThan(0);
  });

  it("renames the project in place from the overview title", () => {
    renderAt("/project/p1");
    const input = screen.getByLabelText("Project name");
    fireEvent.change(input, { target: { value: "Aurora 2" } });
    fireEvent.blur(input);
    expect(screen.getByTestId("probe")).toHaveTextContent("Aurora 2|");
  });

  it("shows only the selected view", () => {
    renderAt("/project/p1?view=tasks");
    expect(screen.getByText("Epics & Tasks")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Paste from Sheets" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Project summary")).toBeNull();
    expect(screen.queryByText("Teams on this project")).toBeNull();
  });

  it("opens the paste import from the task editor", () => {
    renderAt("/project/p1?view=tasks");
    fireEvent.click(screen.getByRole("button", { name: "Paste from Sheets" }));
    expect(screen.getByLabelText("Pasted rows")).toBeInTheDocument();
  });

  it("groups teams, start dates and helpers under people", () => {
    renderAt("/project/p1?view=people");
    expect(screen.getByText("Teams on this project")).toBeInTheDocument();
    expect(screen.getByText("Team start dates")).toBeInTheDocument();
    expect(screen.getByText("Project helpers")).toBeInTheDocument();
  });

  it("sets the project accent and offers the export in settings", () => {
    renderAt("/project/p1?view=settings");
    const accent = screen.getByRole("group", { name: "Project accent" });
    const good = screen.getByRole("button", { name: "Good option" });
    expect(accent).toContainElement(good);
    fireEvent.click(good);
    expect(screen.getByTestId("probe")).toHaveTextContent("#4C6EF5");
    expect(good).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("button", { name: "Export project" }),
    ).toBeInTheDocument();
  });

  it("explains a missing project instead of rendering a blank page", () => {
    renderAt("/project/nope");
    expect(screen.getByText("Project not found")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "All projects" })).toHaveAttribute(
      "href",
      "/",
    );
  });
});
