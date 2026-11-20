import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { AppState } from "@planner/core";
import { AppStoreProvider } from "@planner/client-runtime";
import { ToastProvider } from "../ui/Toast";
import { ConfirmProvider } from "../ui/ConfirmDialog";
import { Sidebar } from "./Sidebar";

const STATE: AppState = {
  projects: [
    {
      id: "p1",
      name: "Aurora Launch",
      startDate: "2026-11-20",
      planViewMode: "person",
      plan: null,
      epics: [],
    },
  ],
  teams: [],
};

function renderSidebar(path = "/") {
  return render(
    <ToastProvider>
      <ConfirmProvider>
        <AppStoreProvider initial={STATE}>
          <MemoryRouter initialEntries={[path]}>
            <Sidebar />
          </MemoryRouter>
        </AppStoreProvider>
      </ConfirmProvider>
    </ToastProvider>,
  );
}

describe("Sidebar", () => {
  beforeEach(() => localStorage.clear());

  it("links the three sections, each with an icon", () => {
    renderSidebar();
    for (const label of ["Projects", "Teams", "Tracking"]) {
      const link = screen.getByRole("link", { name: label });
      expect(link.querySelector("svg")).not.toBeNull();
    }
    expect(screen.getByRole("link", { name: "Projects" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("keeps Projects active inside a project", () => {
    renderSidebar("/project/p1?view=plan");
    expect(screen.getByRole("link", { name: "Projects" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    // A project's views are tabs on its page, not sidebar links.
    expect(screen.queryByRole("link", { name: "Plan & timeline" })).toBeNull();
  });

  it("keeps Tracking active inside a tracker", () => {
    renderSidebar("/tracking/tr1");
    expect(screen.getByRole("link", { name: "Tracking" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("opens the Jira settings dialog", () => {
    renderSidebar();
    expect(screen.queryByText("Jira connection")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Jira/ }));
    expect(screen.getByText("Jira connection")).toBeInTheDocument();
  });

  it("shows a disconnected status dot when Jira isn't configured", () => {
    const { container } = renderSidebar();
    const dot = container.querySelector(".jira-dot");
    expect(dot).not.toBeNull();
    expect(dot).not.toHaveClass("connected");
  });

  it("says the device is local-only when no sync server is set", () => {
    renderSidebar();
    expect(screen.getByText("Local only")).toBeInTheDocument();
  });
});
