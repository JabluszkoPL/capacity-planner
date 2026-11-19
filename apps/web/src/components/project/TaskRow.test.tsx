import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AppState } from "@planner/core";
import { AppStoreProvider, useAppStore } from "@planner/client-runtime";
import { TaskRow } from "./TaskRow";

function stateWith(
  tasks: { id: string; name: string; est: number; excluded?: boolean }[],
): AppState {
  return {
    projects: [
      {
        id: "p1",
        name: "P",
        startDate: "2026-07-27",
        plan: null,
        planViewMode: "person",
        epics: [
          {
            id: "e1",
            name: "E1",
            tasks: tasks.map((t) => ({
              id: t.id,
              name: t.name,
              estimateDays: t.est,
              specialization: "FE",
              excluded: t.excluded ?? false,
            })),
          },
        ],
      },
    ],
    teams: [{ id: "t1", name: "Team 1", members: [], offDays: {} }],
  };
}

function Harness({ taskId }: { taskId: string }) {
  const { state } = useAppStore();
  const epic = state.projects[0].epics[0];
  const idx = epic.tasks.findIndex((t) => t.id === taskId);
  const task = epic.tasks[idx];
  if (!task) return <div>task deleted</div>;
  return (
    <>
      <div data-testid="store-name">{task.name}</div>
      <div data-testid="store-est">{task.estimateDays}</div>
      <table>
        <tbody>
          <TaskRow
            projectId="p1"
            epicId="e1"
            task={task}
            allEpics={state.projects[0].epics}
            isFirst={idx === 0}
            isLast={idx === epic.tasks.length - 1}
            index={idx}
            isDragging={false}
            isDragOver={false}
            onDragStart={() => {}}
            onDragOverRow={() => {}}
            onDrop={() => {}}
            onDragEnd={() => {}}
          />
        </tbody>
      </table>
    </>
  );
}

function renderRow(initial: AppState, taskId = "t1") {
  return render(
    <AppStoreProvider initial={initial}>
      <Harness taskId={taskId} />
    </AppStoreProvider>,
  );
}

describe("TaskRow", () => {
  beforeEach(() => localStorage.clear());

  it("keeps focus while typing and commits only on blur", async () => {
    const user = userEvent.setup();
    renderRow(stateWith([{ id: "t1", name: "T1", est: 2 }]));
    const input = screen.getByLabelText("Task name");

    await user.clear(input);
    await user.type(input, "Renamed");
    // Focus is retained across every keystroke, value accumulated locally.
    expect(input).toHaveFocus();
    expect(input).toHaveValue("Renamed");
    // Nothing committed to the store yet (no per-keystroke dispatch).
    expect(screen.getByTestId("store-name")).toHaveTextContent("T1");

    fireEvent.blur(input);
    expect(screen.getByTestId("store-name")).toHaveTextContent("Renamed");
  });

  it("commits an edited estimate on blur", async () => {
    const user = userEvent.setup();
    renderRow(stateWith([{ id: "t1", name: "T1", est: 2 }]));
    const est = screen.getByLabelText("Estimate in days");
    await user.clear(est);
    await user.type(est, "3.5");
    expect(screen.getByTestId("store-est")).toHaveTextContent("2");
    fireEvent.blur(est);
    expect(screen.getByTestId("store-est")).toHaveTextContent("3.5");
  });

  it("toggling the chip flips excluded and de-emphasizes the row", () => {
    const { container } = renderRow(
      stateWith([{ id: "t1", name: "T1", est: 2 }]),
    );
    expect(container.querySelector("tr.excluded")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Included" }));
    expect(screen.getByRole("button", { name: "Skipped" })).toBeInTheDocument();
    expect(container.querySelector("tr.excluded")).not.toBeNull();
  });

  it("deletes the task without a confirmation dialog", () => {
    renderRow(stateWith([{ id: "t1", name: "T1", est: 2 }]));
    fireEvent.click(screen.getByRole("button", { name: "Delete task T1" }));
    expect(screen.getByText("task deleted")).toBeInTheDocument();
  });

  it("suggests only the selected teams' specializations, without forcing one", async () => {
    const user = userEvent.setup();
    const base = stateWith([{ id: "t1", name: "T1", est: 2 }]);
    renderRow({
      ...base,
      projects: [{ ...base.projects[0], teamInclusions: [{ teamId: "t1" }] }],
      teams: [
        {
          id: "t1",
          name: "Team 1",
          members: [
            { id: "m1", name: "Ann", specialization: "FE" },
            { id: "m2", name: "Bo", specialization: "BE" },
          ],
          offDays: {},
        },
        {
          id: "t2",
          name: "Team 2",
          members: [{ id: "m3", name: "Cy", specialization: "QA" }],
          offDays: {},
        },
      ],
    });
    const spec = screen.getByRole("combobox", { name: "Specialization" });

    // The field already holds "FE", yet a click lists every option.
    await user.click(spec);
    const names = () => screen.getAllByRole("option").map((o) => o.textContent);
    expect(names()).toEqual(["FE", "BE"]);

    await user.click(screen.getByRole("option", { name: "BE" }));
    expect(spec).toHaveValue("BE");
    expect(screen.queryByRole("listbox")).toBeNull();

    // Free text is still accepted.
    await user.clear(spec);
    await user.type(spec, "Design{Enter}");
    expect(spec).toHaveValue("Design");
    expect(spec).not.toHaveFocus();
  });
});
