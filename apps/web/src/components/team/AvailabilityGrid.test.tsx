import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { type AppState, addDays, startOfWeek, toISO } from "@planner/core";
import { AppStoreProvider, useAppStore } from "@planner/client-runtime";

import { AvailabilityGrid } from "./AvailabilityGrid";

// The grid starts on the Monday of the current week, so indices 0..4 are
// weekdays (Mon–Fri) and 5..6 are the weekend.
const gridStart = () => {
  const t = new Date();
  t.setHours(0, 0, 0, 0);
  return startOfWeek(t);
};
const dateAt = (i: number) => toISO(addDays(gridStart(), i));

function baseState(): AppState {
  return {
    projects: [],
    teams: [
      {
        id: "t1",
        name: "Team 1",
        members: [
          { id: "m1", name: "Alice", specialization: "FE" },
          { id: "m2", name: "Ben", specialization: "BE" },
        ],
        offDays: {},
      },
    ],
  };
}

function Harness() {
  const { state } = useAppStore();
  return (
    <>
      <div data-testid="m1-off">
        {(state.teams[0].offDays.m1 ?? []).join(",")}
      </div>
      <div data-testid="m2-off">
        {(state.teams[0].offDays.m2 ?? []).join(",")}
      </div>
      <AvailabilityGrid />
    </>
  );
}

function renderGrid(initial = baseState()) {
  return render(
    <AppStoreProvider initial={initial}>
      <Harness />
    </AppStoreProvider>,
  );
}

const cellsFor = (container: HTMLElement, memberId: string) =>
  Array.from(
    container.querySelectorAll<HTMLElement>(`[data-member="${memberId}"]`),
  );

describe("AvailabilityGrid", () => {
  beforeEach(() => localStorage.clear());

  it("shows an empty state with no members", () => {
    renderGrid({
      projects: [],
      teams: [{ id: "t1", name: "Team 1", members: [], offDays: {} }],
    });
    expect(
      screen.getByText(/Add team members above to mark their days off/i),
    ).toBeInTheDocument();
  });

  it("toggles a single day on click (down + up)", () => {
    const { container } = renderGrid();
    const cell = cellsFor(container, "m1")[0];
    fireEvent.mouseDown(cell);
    fireEvent.mouseUp(document);
    expect(screen.getByTestId("m1-off")).toHaveTextContent(dateAt(0));

    // Clicking the same day again clears it.
    fireEvent.mouseDown(cell);
    fireEvent.mouseUp(document);
    expect(screen.getByTestId("m1-off")).toHaveTextContent("");
  });

  it("paints multiple days in one drag (mousedown → mouseover → mouseup)", () => {
    const { container } = renderGrid();
    const cells = cellsFor(container, "m1");
    fireEvent.mouseDown(cells[0]);
    fireEvent.mouseOver(cells[1]);
    fireEvent.mouseOver(cells[2]);
    fireEvent.mouseUp(document);

    expect(screen.getByTestId("m1-off")).toHaveTextContent(
      [dateAt(0), dateAt(1), dateAt(2)].join(","),
    );
  });

  it("does not let a drag bleed into another member's row", () => {
    const { container } = renderGrid();
    const m1 = cellsFor(container, "m1");
    const m2 = cellsFor(container, "m2");
    fireEvent.mouseDown(m1[0]);
    fireEvent.mouseOver(m2[1]); // different row — must be ignored
    fireEvent.mouseUp(document);

    expect(screen.getByTestId("m1-off")).toHaveTextContent(dateAt(0));
    expect(screen.getByTestId("m2-off")).toHaveTextContent("");
  });

  it("keeps weekend cells non-interactive", () => {
    const { container } = renderGrid();
    const weekendCell = cellsFor(container, "m1")[5]; // Saturday
    expect(weekendCell.className).toContain("weekend");
    fireEvent.mouseDown(weekendCell);
    fireEvent.mouseUp(document);
    expect(screen.getByTestId("m1-off")).toHaveTextContent("");
  });

  it("persists painted off-days to the store (survives reload)", () => {
    const { container } = renderGrid();
    const cells = cellsFor(container, "m1");
    fireEvent.mouseDown(cells[0]);
    fireEvent.mouseOver(cells[1]);
    fireEvent.mouseUp(document);
    // The store is the persistence source of truth (debounced-saved to
    // localStorage); asserting it holds the painted days covers reload.
    expect(screen.getByTestId("m1-off")).toHaveTextContent(
      [dateAt(0), dateAt(1)].join(","),
    );
  });
});
