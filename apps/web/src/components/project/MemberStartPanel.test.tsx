import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { AppState } from "@planner/core";
import { AppStoreProvider, useAppStore } from "@planner/client-runtime";
import { MemberStartPanel } from "./MemberStartPanel";

function baseState(): AppState {
  return {
    projects: [
      {
        id: "p1",
        name: "P",
        startDate: "2026-07-27",
        plan: null,
        planViewMode: "person",
        epics: [],
        helpers: [],
        memberStarts: {},
      },
    ],
    teams: [
      {
        id: "t1",
        name: "Team 1",
        members: [{ id: "m1", name: "Alice", specialization: "FE" }],
        offDays: {},
      },
    ],
  };
}

function Harness() {
  const { state } = useAppStore();
  return (
    <>
      <div data-testid="starts">
        {JSON.stringify(state.projects[0].memberStarts)}
      </div>
      <MemberStartPanel project={state.projects[0]} />
    </>
  );
}

function renderPanel(initial = baseState()) {
  return render(
    <AppStoreProvider initial={initial}>
      <Harness />
    </AppStoreProvider>,
  );
}

describe("MemberStartPanel", () => {
  beforeEach(() => localStorage.clear());

  it("starts collapsed, hiding the member list until expanded", () => {
    renderPanel();
    expect(screen.queryByLabelText("Start date for Alice")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Expand team start dates" }),
    );
    expect(screen.getByLabelText("Start date for Alice")).toBeInTheDocument();
  });

  it("shows an empty state when there are no team members", () => {
    renderPanel({
      ...baseState(),
      teams: [{ id: "t1", name: "Team 1", members: [], offDays: {} }],
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Expand team start dates" }),
    );
    expect(screen.getByText("No team members")).toBeInTheDocument();
  });

  it("sets and clears a member's start-date override", () => {
    renderPanel();
    fireEvent.click(
      screen.getByRole("button", { name: "Expand team start dates" }),
    );
    const input = screen.getByLabelText("Start date for Alice");
    fireEvent.change(input, { target: { value: "2026-08-10" } });
    expect(screen.getByTestId("starts")).toHaveTextContent(
      '{"m1":"2026-08-10"}',
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Clear start date for Alice" }),
    );
    expect(screen.getByTestId("starts")).toHaveTextContent("{}");
  });
});
