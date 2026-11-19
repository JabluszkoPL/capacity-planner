import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { JiraEpic, JiraIssue, JiraSnapshot, Project } from "@planner/core";
import { TasksTable } from "./TasksTable";

const SITE = "https://acme.atlassian.net";

function task(key: string, summary: string, done = false): JiraIssue {
  return {
    key,
    summary,
    issueType: "Task",
    status: done ? "Done" : "In Progress",
    statusCategory: done ? "done" : "indeterminate",
    updated: "2026-09-21T08:00:00.000Z",
  };
}

function epic(key: string, summary: string, children: JiraIssue[]): JiraEpic {
  return {
    key,
    summary,
    issueType: "Epic",
    status: "In Progress",
    statusCategory: "indeterminate",
    updated: "2026-09-21T08:00:00.000Z",
    children,
    totals: {
      originalSec: 0,
      spentSec: 0,
      remainingSec: 0,
      done: children.filter((child) => child.statusCategory === "done").length,
      all: children.length,
    },
  };
}

const snapshot: JiraSnapshot = {
  fetchedAt: "2026-09-21T09:00:00.000Z",
  initiative: {
    key: "ACME-1",
    summary: "Initiative",
    issueType: "Initiative",
    status: "In Progress",
    statusCategory: "indeterminate",
    updated: "2026-09-21T08:00:00.000Z",
  },
  epics: [
    epic("ACME-10", "Renamed Jira epic", [
      task("ACME-11", "Build checkout", true),
      task("ACME-12", "Test checkout"),
    ]),
    epic("ACME-20", "Payments", [task("ACME-21", "Refunds")]),
  ],
  fieldIds: {},
};

const project: Project = {
  id: "p1",
  name: "Plan",
  startDate: "2026-09-21",
  planViewMode: "person",
  plan: null,
  epics: [
    {
      id: "e1",
      name: "Original plan epic",
      tasks: [
        {
          id: "t1",
          name: "Build checkout",
          estimateDays: 5,
          specialization: "dev",
          excluded: false,
        },
        {
          id: "t2",
          name: "Test checkout",
          estimateDays: 3,
          specialization: "qa",
          excluded: false,
        },
      ],
    },
  ],
};

function expand(epicSummary: string) {
  fireEvent.click(screen.getByRole("button", { name: epicSummary }));
}

describe("TasksTable", () => {
  it("flags tasks mapped onto a plan task with no estimate", () => {
    const unestimated: Project = {
      ...project,
      epics: [
        {
          ...project.epics[0],
          tasks: [
            project.epics[0].tasks[0],
            // Imported from Jira with no estimate: skipped at 0 days.
            { ...project.epics[0].tasks[1], estimateDays: 0, excluded: true },
          ],
        },
      ],
    };
    render(
      <TasksTable
        snapshot={snapshot}
        baseUrl={SITE}
        project={unestimated}
        taskMap={{ "ACME-11": "t1", "ACME-12": "t2" }}
        onMapTask={() => {}}
      />,
    );

    const epicRow = screen
      .getByRole("button", { name: "Renamed Jira epic" })
      .closest("tr") as HTMLElement;
    expect(within(epicRow).getByText("1 without estimate")).toBeInTheDocument();
    const payments = screen
      .getByRole("button", { name: "Payments" })
      .closest("tr") as HTMLElement;
    expect(within(payments).queryByText(/without estimate/)).toBeNull();

    expand("Renamed Jira epic");
    const rows = screen.getAllByRole("row", { name: /ACME-1[12]/ });
    // Sorted to the top, marked, and saying so in words.
    expect(rows[0]).toHaveAccessibleName(/ACME-12/);
    expect(rows[0]).toHaveClass("no-estimate");
    expect(within(rows[0]).getByText("No estimate")).toBeInTheDocument();
    expect(rows[1]).not.toHaveClass("no-estimate");
    // Jira has no estimate for it either, so it has to be set there first.
    expect(within(rows[0]).getByText("none in Jira")).toBeInTheDocument();
  });

  it("greys out a done task with no estimate, and does not count it", () => {
    const unestimated: Project = {
      ...project,
      epics: [
        {
          ...project.epics[0],
          tasks: [
            // Done in Jira (ACME-11) but never estimated in the plan.
            { ...project.epics[0].tasks[0], estimateDays: 0, excluded: true },
            project.epics[0].tasks[1],
          ],
        },
      ],
    };
    render(
      <TasksTable
        snapshot={snapshot}
        baseUrl={SITE}
        project={unestimated}
        taskMap={{ "ACME-11": "t1", "ACME-12": "t2" }}
        onMapTask={() => {}}
      />,
    );

    const epicRow = screen
      .getByRole("button", { name: "Renamed Jira epic" })
      .closest("tr") as HTMLElement;
    expect(within(epicRow).queryByText(/without estimate/)).toBeNull();

    expand("Renamed Jira epic");
    const row = screen.getByRole("row", { name: /ACME-11/ });
    expect(row).not.toHaveClass("no-estimate");
    expect(within(row).getByText("No estimate")).toHaveClass("done");
    expect(within(row).getByText("already done")).toBeInTheDocument();
    expect(within(row).queryByText("none in Jira")).toBeNull();
  });

  it("lists to do first, then in progress, then done, in every sort", () => {
    const todo = (key: string, summary: string): JiraIssue => ({
      ...task(key, summary),
      status: "To Do",
      statusCategory: "new",
    });
    const mixed: JiraSnapshot = {
      ...snapshot,
      epics: [
        epic("ACME-10", "Renamed Jira epic", [
          task("ACME-11", "Build checkout", true),
          task("ACME-12", "Test checkout"),
          todo("ACME-13", "Ship checkout"),
          task("ACME-14", "Polish checkout", true),
          todo("ACME-15", "Document checkout"),
        ]),
      ],
    };
    render(
      <TasksTable
        snapshot={mixed}
        baseUrl={SITE}
        project={project}
        taskMap={{ "ACME-11": "t1", "ACME-12": "t2" }}
        onMapTask={() => {}}
      />,
    );
    expand("Renamed Jira epic");
    const keys = () =>
      screen
        .getAllByRole("row", { name: /ACME-1\d/ })
        .filter((row) => row.classList.contains("task-row"))
        .map((row) => within(row).getByRole("link").textContent);
    // Unmatched first (the default) still orders within each status: the
    // unmapped ACME-14 comes before the mapped ACME-11 among the done ones.
    expect(keys()).toEqual([
      "ACME-13",
      "ACME-15",
      "ACME-12",
      "ACME-14",
      "ACME-11",
    ]);
    fireEvent.change(screen.getByRole("combobox", { name: "Sort" }), {
      target: { value: "order" },
    });
    expect(keys()).toEqual([
      "ACME-13",
      "ACME-15",
      "ACME-12",
      "ACME-11",
      "ACME-14",
    ]);
  });

  it("groups each category by status, and sinks not-tracked tasks last", () => {
    const withStatus = (
      issue: JiraIssue,
      status: string,
      statusCategory: JiraIssue["statusCategory"],
    ): JiraIssue => ({ ...issue, status, statusCategory });
    const mixed: JiraSnapshot = {
      ...snapshot,
      epics: [
        epic("ACME-10", "Renamed Jira epic", [
          withStatus(task("ACME-11", "Build checkout"), "Cancelled", "done"),
          task("ACME-12", "Test checkout", true),
          withStatus(
            task("ACME-13", "Ship checkout"),
            "In Review",
            "indeterminate",
          ),
          task("ACME-14", "Polish checkout"),
          withStatus(task("ACME-15", "Drop checkout"), "Won't Do", "done"),
          task("ACME-16", "Ignore checkout", true),
          withStatus(task("ACME-17", "Plan checkout"), "To Do", "new"),
          task("ACME-18", "Another done", true),
        ]),
      ],
    };
    render(
      <TasksTable
        snapshot={mixed}
        baseUrl={SITE}
        project={project}
        taskMap={{ "ACME-16": null, "ACME-17": null }}
        onMapTask={() => {}}
      />,
    );
    expand("Renamed Jira epic");
    fireEvent.change(screen.getByRole("combobox", { name: "Sort" }), {
      target: { value: "order" },
    });
    const keys = screen
      .getAllByRole("row", { name: /ACME-1\d/ })
      .filter((row) => row.classList.contains("task-row"))
      .map((row) => within(row).getByRole("link").textContent);
    expect(keys).toEqual([
      // In progress, one block per status: "In Progress" before "In Review".
      "ACME-14",
      "ACME-13",
      // Done before the statuses that close work without doing it.
      "ACME-12",
      "ACME-18",
      "ACME-11",
      "ACME-15",
      // Not tracked last, still in status order among themselves.
      "ACME-17",
      "ACME-16",
    ]);
  });

  it("shows each task's team, and lets you set one", () => {
    const onSetTaskTeam = vi.fn();
    const teams = [
      { name: "Stars", tasks: 1, plannerTeamId: "t1" },
      { name: "Bulls", tasks: 1, plannerTeamId: null },
    ];
    render(
      <TasksTable
        snapshot={snapshot}
        baseUrl={SITE}
        project={project}
        taskMap={{ "ACME-11": "t1", "ACME-12": "t2" }}
        onMapTask={() => {}}
        teams={teams}
        taskTeams={
          new Map([
            ["ACME-11", { team: "Stars", source: "assignee" as const }],
            ["ACME-12", { team: "Bulls", source: "set" as const }],
          ])
        }
        onSetTaskTeam={onSetTaskTeam}
      />,
    );
    expand("Renamed Jira epic");
    const worked = screen.getByRole("combobox", {
      name: "Team for ACME-11 Build checkout",
    });
    expect(worked).toHaveValue("");
    expect(
      screen.getByRole("option", { name: "From Jira: Stars (assignee)" }),
    ).toBeInTheDocument();
    const set = screen.getByRole("combobox", {
      name: "Team for ACME-12 Test checkout",
    });
    expect(set).toHaveValue("Bulls");

    fireEvent.change(worked, { target: { value: "Bulls" } });
    expect(onSetTaskTeam).toHaveBeenLastCalledWith("ACME-11", "Bulls");
    fireEvent.change(set, { target: { value: "" } });
    expect(onSetTaskTeam).toHaveBeenLastCalledWith("ACME-12", null);
  });

  it("has no Team column with a single team", () => {
    render(
      <TasksTable
        snapshot={snapshot}
        baseUrl={SITE}
        project={project}
        taskMap={{}}
        onMapTask={() => {}}
        teams={[{ name: "Stars", tasks: 2, plannerTeamId: "t1" }]}
      />,
    );
    expect(screen.queryByRole("columnheader", { name: "Team" })).toBeNull();
  });

  it("filters the tasks by specialization", () => {
    render(
      <TasksTable
        snapshot={snapshot}
        baseUrl={SITE}
        project={project}
        // ACME-11 -> dev, ACME-12 -> qa, ACME-21 unmapped.
        taskMap={{ "ACME-11": "t1", "ACME-12": "t2" }}
        onMapTask={() => {}}
      />,
    );
    const filter = screen.getByRole("combobox", { name: "Specialization" });
    expect(
      within(filter)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["All", "dev", "qa", "Not mapped"]);
    const taskKeys = () =>
      screen
        .queryAllByRole("row")
        .filter((row) => row.classList.contains("task-row"))
        .map((row) => within(row).getByRole("link").textContent);

    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
    expect(taskKeys()).toEqual(["ACME-12", "ACME-11", "ACME-21"]);

    fireEvent.change(filter, { target: { value: "qa" } });
    expect(taskKeys()).toEqual(["ACME-12"]);
    // An epic with none of them is hidden, and the epic counts follow.
    expect(screen.queryByRole("button", { name: "Payments" })).toBeNull();
    const epicRow = screen
      .getByRole("button", { name: "Renamed Jira epic" })
      .closest("tr") as HTMLElement;
    expect(within(epicRow).getByText("1 task")).toBeInTheDocument();

    fireEvent.change(filter, { target: { value: "__unmapped__" } });
    expect(taskKeys()).toEqual(["ACME-21"]);
  });

  it("shows an epic's status once it is done", () => {
    const doneEpic: JiraSnapshot = {
      ...snapshot,
      epics: [
        {
          ...snapshot.epics[0],
          status: "Done",
          statusCategory: "done",
        },
        snapshot.epics[1],
      ],
    };
    render(
      <TasksTable
        snapshot={doneEpic}
        baseUrl={SITE}
        project={project}
        taskMap={{ "ACME-11": "t1", "ACME-12": "t2" }}
        onMapTask={() => {}}
      />,
    );
    const epicRow = screen
      .getByRole("button", { name: "Renamed Jira epic" })
      .closest("tr") as HTMLElement;
    expect(within(epicRow).getByText("Done")).toHaveClass(
      "jira-status",
      "done",
    );
    // An epic still in progress shows no status: only done is worth a badge.
    const payments = screen
      .getByRole("button", { name: "Payments" })
      .closest("tr") as HTMLElement;
    expect(payments.querySelector(".jira-status")).toBeNull();
  });

  it("says when Jira already has the estimate, and offers to copy it", () => {
    const onReview = vi.fn();
    const withEstimate: JiraSnapshot = {
      ...snapshot,
      epics: [
        epic("ACME-10", "Renamed Jira epic", [
          task("ACME-11", "Build checkout", true),
          {
            ...task("ACME-12", "Test checkout"),
            originalEstimateSec: 5 * 8 * 3600,
          },
        ]),
      ],
    };
    const unestimated: Project = {
      ...project,
      epics: [
        {
          ...project.epics[0],
          tasks: [
            project.epics[0].tasks[0],
            { ...project.epics[0].tasks[1], estimateDays: 0, excluded: true },
          ],
        },
      ],
    };
    render(
      <TasksTable
        snapshot={withEstimate}
        baseUrl={SITE}
        project={unestimated}
        taskMap={{ "ACME-11": "t1", "ACME-12": "t2" }}
        onMapTask={() => {}}
        hoursPerDay={8}
        onReviewEstimates={onReview}
      />,
    );
    expand("Renamed Jira epic");
    const row = screen.getByRole("row", { name: /ACME-12/ });
    expect(within(row).getByText("No estimate")).toBeInTheDocument();
    expect(row).toHaveTextContent("Jira: 5 d");
    fireEvent.click(within(row).getByRole("button", { name: "Copy it" }));
    expect(onReview).toHaveBeenCalledTimes(1);
  });

  it("compares Jira child tasks without depending on epic names", () => {
    render(
      <TasksTable
        snapshot={snapshot}
        baseUrl={SITE}
        project={project}
        taskMap={{ "ACME-11": "t1", "ACME-12": "t2" }}
        onMapTask={() => {}}
      />,
    );
    expand("Renamed Jira epic");

    const done = screen.getByRole("row", { name: /ACME-11/ });
    const doneCells = within(done).getAllByRole("cell");
    expect(doneCells[4]).toHaveTextContent("5");
    expect(doneCells[5]).toHaveTextContent("5");
    expect(doneCells[6]).toHaveTextContent("Yes");

    const open = screen.getByRole("row", { name: /ACME-12/ });
    const openCells = within(open).getAllByRole("cell");
    expect(openCells[4]).toHaveTextContent("3");
    expect(openCells[5]).toHaveTextContent("0");
    expect(openCells[6]).toHaveTextContent("No");
  });

  it("reports manual mapping and exclusion choices", async () => {
    const user = userEvent.setup();
    const onMapTask = vi.fn();
    render(
      <TasksTable
        snapshot={snapshot}
        baseUrl={SITE}
        project={project}
        taskMap={{}}
        onMapTask={onMapTask}
      />,
    );
    expand("Renamed Jira epic");

    const picker = screen.getByRole("combobox", {
      name: "Plan task for ACME-11 Build checkout",
    });
    expect(picker).toHaveValue("Unmapped");
    await user.click(picker);
    await user.click(screen.getByRole("option", { name: "Build checkout" }));
    expect(onMapTask).toHaveBeenCalledWith("ACME-11", "t1");
    await user.click(picker);
    await user.click(
      screen.getByRole("option", { name: "Not tracked (another team)" }),
    );
    expect(onMapTask).toHaveBeenCalledWith("ACME-11", null);
  });

  it("marks a Jira task as added scope, guessing its specialization", async () => {
    const user = userEvent.setup();
    const onSetAddedScope = vi.fn();
    const withQa: JiraSnapshot = {
      ...snapshot,
      epics: [
        epic("ACME-20", "Payments", [
          task("ACME-22", "[QA] Refund regression"),
        ]),
      ],
    };
    render(
      <TasksTable
        snapshot={withQa}
        baseUrl={SITE}
        project={project}
        taskMap={{}}
        onMapTask={() => {}}
        specializations={["dev", "qa"]}
        onSetAddedScope={onSetAddedScope}
      />,
    );
    expand("Payments");
    await user.click(
      screen.getByRole("combobox", {
        name: "Plan task for ACME-22 [QA] Refund regression",
      }),
    );
    await user.click(
      screen.getByRole("option", { name: "Added scope (our team)" }),
    );
    expect(onSetAddedScope).toHaveBeenCalledWith("ACME-22", "qa");
  });

  it("counts added scope by Jira's estimate, with its specialization", async () => {
    const user = userEvent.setup();
    const onSetAddedScope = vi.fn();
    const withEstimate: JiraSnapshot = {
      ...snapshot,
      epics: [
        epic("ACME-20", "Payments", [
          {
            ...task("ACME-21", "Refunds", true),
            originalEstimateSec: 3 * 8 * 3600,
          },
        ]),
      ],
    };
    render(
      <TasksTable
        snapshot={withEstimate}
        baseUrl={SITE}
        project={project}
        taskMap={{ "ACME-21": null }}
        onMapTask={() => {}}
        hoursPerDay={8}
        addedScope={{ "ACME-21": "dev" }}
        specializations={["dev", "qa"]}
        onSetAddedScope={onSetAddedScope}
      />,
    );
    const epicRow = screen
      .getByRole("button", { name: "Payments" })
      .closest("tr") as HTMLElement;
    expect(within(epicRow).getByText("1 added scope")).toBeInTheDocument();

    expand("Payments");
    const row = screen.getByRole("row", { name: /ACME-21/ });
    expect(row).toHaveClass("added");
    expect(
      within(row).getByRole("combobox", { name: /Plan task for ACME-21/ }),
    ).toHaveValue("Added scope (our team)");
    const cells = within(row).getAllByRole("cell");
    expect(cells[4]).toHaveTextContent("3"); // planned, from Jira
    expect(cells[5]).toHaveTextContent("3"); // done, so earned

    await user.selectOptions(
      within(row).getByLabelText("Specialization for ACME-21 Refunds"),
      "qa",
    );
    expect(onSetAddedScope).toHaveBeenCalledWith("ACME-21", "qa");
  });

  it("leaves a whole epic out as another team's, and sorts it last", async () => {
    const user = userEvent.setup();
    const onSetEpicTracked = vi.fn();
    const props = {
      snapshot,
      baseUrl: SITE,
      project,
      taskMap: { "ACME-11": "t1", "ACME-12": "t2" },
      onMapTask: () => {},
      onSetEpicTracked,
    };
    const { rerender } = render(<TasksTable {...props} />);

    // Tracked: Jira's order, and the control says so.
    const control = screen.getByLabelText(
      "Tracking for epic ACME-10 Renamed Jira epic",
    );
    expect(control).toHaveValue("tracked");
    await user.selectOptions(control, "untracked");
    expect(onSetEpicTracked).toHaveBeenCalledWith("ACME-10", false);

    rerender(<TasksTable {...props} untrackedEpics={["ACME-10"]} />);
    const epicRows = () =>
      screen
        .getAllByRole("button", { name: /Renamed Jira epic|Payments/ })
        .map((b) => b.textContent?.replace(/[▸▾]/g, "").trim());
    // Sorted last, marked in words, and its days no longer count.
    expect(epicRows()).toEqual(["Payments", "Renamed Jira epic"]);
    const theirs = screen
      .getByRole("button", { name: "Renamed Jira epic" })
      .closest("tr") as HTMLElement;
    expect(
      within(theirs).getByText("Not tracked (another team)", {
        selector: ".untracked-label",
      }),
    ).toBeInTheDocument();
    expect(within(theirs).getAllByRole("cell")[0]).toHaveTextContent("—");

    // Its tasks keep their mapping underneath but show as not tracked.
    expand("Renamed Jira epic");
    const row = screen.getByRole("row", { name: /ACME-11/ });
    expect(within(row).getByText("Not tracked (epic)")).toBeInTheDocument();
    expect(within(row).queryByRole("combobox")).toBeNull();

    // Jira's own order is left alone.
    await user.selectOptions(screen.getByLabelText("Sort"), "order");
    expect(epicRows()).toEqual(["Renamed Jira epic", "Payments"]);
  });

  it("finds a plan task by typing into the picker", async () => {
    const user = userEvent.setup();
    const onMapTask = vi.fn();
    render(
      <TasksTable
        snapshot={snapshot}
        baseUrl={SITE}
        project={project}
        taskMap={{ "ACME-11": "t1" }}
        onMapTask={onMapTask}
      />,
    );
    expand("Renamed Jira epic");

    const picker = screen.getByRole("combobox", {
      name: "Plan task for ACME-12 Test checkout",
    });
    await user.click(picker);
    await user.keyboard("test");
    expect(
      within(screen.getByRole("listbox"))
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Test checkout"]);
    await user.keyboard("{Enter}");
    expect(onMapTask).toHaveBeenCalledWith("ACME-12", "t2");

    // An epic name matches all of its tasks; a miss says so.
    await user.click(picker);
    await user.keyboard("original plan");
    expect(
      within(screen.getByRole("listbox")).getAllByRole("option"),
    ).toHaveLength(2);
    await user.clear(picker);
    await user.keyboard("nothing like it");
    expect(
      within(screen.getByRole("listbox")).queryAllByRole("option"),
    ).toHaveLength(0);
    expect(screen.getByText(/No matches/)).toBeInTheDocument();

    // Leaving without a pick keeps the current choice (still unmapped here:
    // the mock doesn't feed the earlier pick back into taskMap).
    await user.keyboard("{Escape}");
    await user.tab();
    expect(picker).toHaveValue("Unmapped");
    expect(onMapTask).toHaveBeenCalledTimes(1);
  });

  it("lists planned tasks that have no Jira match", () => {
    render(
      <TasksTable
        snapshot={snapshot}
        baseUrl={SITE}
        project={project}
        taskMap={{ "ACME-11": "t1" }}
        onMapTask={() => {}}
      />,
    );
    expect(
      screen.getByText(
        /plan tasks with no Jira task mapped to them: Original plan epic \/ Test checkout/i,
      ),
    ).toBeInTheDocument();
  });

  it("groups tasks under collapsible Jira epics with their totals", () => {
    render(
      <TasksTable
        snapshot={snapshot}
        baseUrl={SITE}
        project={project}
        taskMap={{ "ACME-11": "t1", "ACME-12": "t2" }}
        onMapTask={() => {}}
      />,
    );

    // Collapsed by default: epic rows only, each with its own totals.
    expect(screen.queryByRole("row", { name: /ACME-11/ })).toBeNull();
    const checkout = screen.getByRole("button", { name: "Renamed Jira epic" });
    expect(checkout).toHaveAttribute("aria-expanded", "false");
    const epicRow = checkout.closest("tr")!;
    const epicCells = within(epicRow as HTMLElement).getAllByRole("cell");
    expect(epicCells[0]).toHaveTextContent("8");
    expect(epicCells[1]).toHaveTextContent("5");
    expect(epicCells[2]).toHaveTextContent("1/2");

    // Only the epic with an undecided task flags it.
    const payments = screen.getByRole("button", { name: "Payments" });
    expect(
      within(payments.closest("tr") as HTMLElement).getByText("1 unmapped"),
    ).toBeInTheDocument();
    expect(within(epicRow as HTMLElement).queryByText(/unmapped/)).toBeNull();

    fireEvent.click(checkout);
    expect(checkout).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("row", { name: /ACME-11/ })).toBeInTheDocument();
    expect(screen.queryByRole("row", { name: /ACME-21/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
    expect(screen.getByRole("row", { name: /ACME-21/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(screen.queryByRole("row", { name: /ACME-11/ })).toBeNull();
    expect(screen.queryByRole("row", { name: /ACME-21/ })).toBeNull();
  });
});
