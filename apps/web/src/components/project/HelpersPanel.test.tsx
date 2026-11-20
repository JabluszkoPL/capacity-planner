import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { AppState } from "@planner/core";
import { AppStoreProvider, useAppStore } from "@planner/client-runtime";
import { HelpersPanel } from "./HelpersPanel";

function stateWithProject(): AppState {
  return {
    projects: [
      {
        id: "p1",
        name: "P",
        startDate: "2026-07-27",
        plan: null,
        planViewMode: "person",
        helpers: [],
        epics: [],
      },
    ],
    teams: [{ id: "t1", name: "Team 1", members: [], offDays: {} }],
  };
}

function Harness() {
  const { state } = useAppStore();
  return <HelpersPanel project={state.projects[0]} />;
}

function renderPanel(initial = stateWithProject()) {
  return render(
    <AppStoreProvider initial={initial}>
      <Harness />
    </AppStoreProvider>,
  );
}

describe("HelpersPanel", () => {
  beforeEach(() => localStorage.clear());

  it("shows an empty state when there are no helpers", () => {
    renderPanel();
    expect(screen.getByText("No helpers")).toBeInTheDocument();
  });

  it("rejects a blank name inline", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Add helper" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/enter a name/i);
  });

  it("adds a helper with speed and availability, then shows it in the list", () => {
    renderPanel();
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Contractor" },
    });
    fireEvent.change(screen.getByLabelText("Specialization"), {
      target: { value: "Backend" },
    });
    fireEvent.change(screen.getByLabelText("Speed"), {
      target: { value: "0.6" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add helper" }));

    expect(screen.getByDisplayValue("Contractor")).toBeInTheDocument();
    // The speed field in the row reflects the stored value.
    expect(screen.getByLabelText("Helper speed")).toHaveValue(0.6);
  });

  it("edits a helper's speed in place and can remove it", () => {
    renderPanel();
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Contractor" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add helper" }));

    fireEvent.change(screen.getByLabelText("Helper speed"), {
      target: { value: "0.8" },
    });
    expect(screen.getByLabelText("Helper speed")).toHaveValue(0.8);

    fireEvent.click(screen.getByRole("button", { name: "Remove Contractor" }));
    expect(screen.getByText("No helpers")).toBeInTheDocument();
  });

  it("adds and removes a helper's day off through the manager", () => {
    renderPanel();
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Contractor" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add helper" }));

    // Cell starts at "None" and opens the manager.
    const cell = screen.getByRole("button", {
      name: "Days off for Contractor",
    });
    expect(cell).toHaveTextContent("None");
    fireEvent.click(cell);

    fireEvent.change(screen.getByLabelText("Off day"), {
      target: { value: "2026-12-25" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add day" }));

    // The count reflects the added day.
    expect(
      screen.getByRole("button", { name: "Days off for Contractor" }),
    ).toHaveTextContent("1 day");

    // Remove it again (label is locale-formatted, so match on the year).
    fireEvent.click(screen.getByRole("button", { name: /Remove .*2026/ }));
    expect(
      screen.getByRole("button", { name: "Days off for Contractor" }),
    ).toHaveTextContent("None");
  });
});
