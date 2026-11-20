import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { AppState } from "@planner/core";
import {
  AppStoreProvider,
  PlannerRuntime,
  createInMemoryLocalStore,
  useAppStore,
} from "@planner/client-runtime";
import { ConfirmProvider } from "../ui/ConfirmDialog";
import { EpicList } from "./EpicList";

function stateWithEpics(names: string[]): AppState {
  return {
    projects: [
      {
        id: "p1",
        name: "P",
        startDate: "2026-07-27",
        plan: null,
        planViewMode: "person",
        epics: names.map((n, i) => ({ id: `e${i}`, name: n, tasks: [] })),
      },
    ],
    teams: [
      {
        id: "t1",
        name: "Team 1",
        members: [{ id: "m1", name: "Alice", specialization: "Frontend" }],
        offDays: {},
      },
    ],
  };
}

function Harness({ onPaste }: { onPaste?: () => void }) {
  const { state } = useAppStore();
  return <EpicList project={state.projects[0]} onPaste={onPaste} />;
}

/**
 * A real runtime over an in-memory database, pre-loaded with `initial`, so the
 * test can assert that an edit actually reached storage rather than merely
 * re-rendering. (`initial` on the provider is the "don't touch the store"
 * escape hatch, so the baseline has to be committed explicitly.)
 */
async function renderList(initial: AppState, onPaste?: () => void) {
  const runtime = new PlannerRuntime({ store: createInMemoryLocalStore() });
  await runtime.commit({ projects: [], teams: [] }, initial);
  const result = render(
    <ConfirmProvider>
      <AppStoreProvider runtime={runtime} initial={initial}>
        <Harness onPaste={onPaste} />
      </AppStoreProvider>
    </ConfirmProvider>,
  );
  return { ...result, runtime };
}

const epicNames = () =>
  screen
    .getAllByLabelText("Epic name")
    .map((i) => (i as HTMLInputElement).value);

describe("EpicList", () => {
  beforeEach(() => localStorage.clear());

  it("renders an empty state when there are no epics", async () => {
    await renderList(stateWithEpics([]));
    expect(screen.getByText("No epics yet")).toBeInTheDocument();
  });

  it("adds an epic via 'Add epic'", async () => {
    await renderList(stateWithEpics(["E1"]));
    expect(epicNames()).toEqual(["E1"]);
    fireEvent.click(screen.getByRole("button", { name: "Add epic" }));
    expect(epicNames()).toEqual(["E1", "New epic"]);
  });

  it("reorders epics and the new order persists (survives reload)", async () => {
    const { runtime } = await renderList(stateWithEpics(["E1", "E2"]));
    expect(epicNames()).toEqual(["E1", "E2"]);

    fireEvent.click(screen.getAllByLabelText("Move epic down")[0]);
    expect(epicNames()).toEqual(["E2", "E1"]);

    // The reordered list must have reached the local database — that is what a
    // page reload would read back.
    await waitFor(async () => {
      const persisted = await runtime.read();
      expect(persisted.projects[0].epics.map((e) => e.name)).toEqual([
        "E2",
        "E1",
      ]);
    });
  });

  it("offers 'Paste from Sheets' in the toolbar only when it can open it", async () => {
    const onPaste = vi.fn();
    const { unmount } = await renderList(stateWithEpics(["E1"]));
    expect(
      screen.queryByRole("button", { name: "Paste from Sheets" }),
    ).toBeNull();
    unmount();

    await renderList(stateWithEpics(["E1"]), onPaste);
    fireEvent.click(screen.getByRole("button", { name: "Paste from Sheets" }));
    expect(onPaste).toHaveBeenCalledTimes(1);
  });
});
