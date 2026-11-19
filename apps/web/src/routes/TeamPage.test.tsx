import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { AppState } from "@planner/core";
import { AppStoreProvider } from "@planner/client-runtime";
import { ConfirmProvider } from "../components/ui/ConfirmDialog";
import { TeamPage } from "./TeamPage";

function stateWith(
  members: { id: string; name: string; spec: string }[],
): AppState {
  return {
    projects: [],
    teams: [
      {
        id: "t1",
        name: "Team 1",
        members: members.map((m) => ({
          id: m.id,
          name: m.name,
          specialization: m.spec,
        })),
        offDays: {},
      },
    ],
  };
}

function renderTeam(initial: AppState) {
  return render(
    <ConfirmProvider>
      <AppStoreProvider initial={initial}>
        <TeamPage />
      </AppStoreProvider>
    </ConfirmProvider>,
  );
}

const datalistValues = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("#spec-list option")).map((o) =>
    o.getAttribute("value"),
  );

describe("TeamPage roster", () => {
  beforeEach(() => localStorage.clear());

  it("shows an empty state when there are no members", () => {
    renderTeam(stateWith([]));
    expect(screen.getByText(/No team members yet/i)).toBeInTheDocument();
  });

  it("renders a chip per member", () => {
    renderTeam(stateWith([{ id: "m1", name: "Alice", spec: "Frontend" }]));
    expect(screen.getByDisplayValue("Alice")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Frontend")).toBeInTheDocument();
  });

  it("adds a member through the form", () => {
    renderTeam(stateWith([]));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Ben Osei" },
    });
    fireEvent.change(screen.getByLabelText("Specialization"), {
      target: { value: "Backend" },
    });
    fireEvent.click(screen.getByRole("button", { name: "+ Add member" }));
    expect(screen.getByDisplayValue("Ben Osei")).toBeInTheDocument();
  });

  it("keeps the specialization datalist in sync with the live roster", () => {
    const { container } = renderTeam(
      stateWith([{ id: "m1", name: "Alice", spec: "Frontend" }]),
    );
    expect(datalistValues(container)).toEqual(["Frontend"]);

    // Adding a member with a new specialization updates the datalist.
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Ben" },
    });
    fireEvent.change(screen.getByLabelText("Specialization"), {
      target: { value: "Backend" },
    });
    fireEvent.click(screen.getByRole("button", { name: "+ Add member" }));
    expect(datalistValues(container).sort()).toEqual(["Backend", "Frontend"]);
  });
});
