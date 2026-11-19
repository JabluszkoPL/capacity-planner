import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import type { JiraEpic, JiraSnapshot, Project } from "@planner/core";
import { EpicsTable } from "./EpicsTable";

const SITE = "https://acme.atlassian.net";
const h = (n: number) => n * 3600;

function epic(
  key: string,
  summary: string,
  totals: Partial<JiraEpic["totals"]> = {},
): JiraEpic {
  return {
    key,
    summary,
    issueType: "Epic",
    status: "In Progress",
    statusCategory: "indeterminate",
    updated: "2026-09-13T09:00:00.000Z",
    children: [],
    totals: {
      originalSec: h(48),
      spentSec: h(24),
      remainingSec: h(24),
      done: 1,
      all: 2,
      ...totals,
    },
  };
}

function snapshot(epics: JiraEpic[]): JiraSnapshot {
  return {
    fetchedAt: "2026-09-13T10:00:00.000Z",
    fieldIds: {},
    initiative: {
      key: "ACME-1",
      summary: "Season 4",
      issueType: "Initiative",
      status: "In Progress",
      statusCategory: "indeterminate",
      updated: "2026-09-13T09:00:00.000Z",
    },
    epics,
  };
}

function project(): Project {
  return {
    id: "p1",
    name: "Season 4",
    startDate: "2026-09-07",
    planViewMode: "person",
    plan: null,
    epics: [
      {
        id: "e-meta",
        name: "Meta loop",
        tasks: [
          {
            id: "t1",
            name: "a",
            estimateDays: 6,
            specialization: "dev",
            excluded: false,
          },
        ],
      },
      {
        id: "e-shop",
        name: "Shop rework",
        tasks: [
          {
            id: "t2",
            name: "b",
            estimateDays: 4,
            specialization: "dev",
            excluded: false,
          },
        ],
      },
    ],
  };
}

describe("EpicsTable", () => {
  it("shows Jira numbers alone when there is no baseline", () => {
    render(
      <EpicsTable
        snapshot={snapshot([epic("ACME-10", "Meta loop")])}
        baseUrl={SITE}
        hoursPerDay={8}
        epicMap={undefined}
      />,
    );
    expect(screen.getByText("Meta loop")).toBeInTheDocument();
    expect(screen.getByText("1/2")).toBeInTheDocument();
    expect(
      screen.queryByRole("columnheader", { name: "Plan epic" }),
    ).not.toBeInTheDocument();
  });

  it("links each epic key back to Jira", () => {
    render(
      <EpicsTable
        snapshot={snapshot([epic("ACME-10", "Meta loop")])}
        baseUrl={SITE}
        hoursPerDay={8}
        epicMap={undefined}
      />,
    );
    expect(screen.getByRole("link", { name: "ACME-10" })).toHaveAttribute(
      "href",
      `${SITE}/browse/ACME-10`,
    );
  });

  it("shows planned and earned days once epics are mapped", () => {
    render(
      <EpicsTable
        snapshot={snapshot([epic("ACME-10", "Meta loop")])}
        baseUrl={SITE}
        hoursPerDay={8}
        project={project()}
        epicMap={{ "ACME-10": "e-meta" }}
      />,
    );
    const row = screen.getByRole("row", { name: /ACME-10/ });
    const cells = within(row).getAllByRole("cell");
    // Columns: key, epic, status, done, plan epic, planned, earned, complete,
    // spent, remaining. 6 plan days, half the time spent -> 3 earned at 50%.
    expect(cells[5]).toHaveTextContent("6");
    expect(cells[6]).toHaveTextContent("3");
    expect(cells[7]).toHaveTextContent("50%");
  });

  it("reports a mapping choice with null for 'not in plan'", () => {
    const onMapEpic = vi.fn();
    render(
      <EpicsTable
        snapshot={snapshot([epic("ACME-10", "Meta loop")])}
        baseUrl={SITE}
        hoursPerDay={8}
        project={project()}
        epicMap={{}}
        onMapEpic={onMapEpic}
      />,
    );
    const select = screen.getByLabelText("Plan epic for ACME-10 Meta loop");
    fireEvent.change(select, { target: { value: "e-shop" } });
    expect(onMapEpic).toHaveBeenCalledWith("ACME-10", "e-shop");

    fireEvent.change(select, { target: { value: "__none__" } });
    expect(onMapEpic).toHaveBeenCalledWith("ACME-10", null);
  });

  it("marks an undecided epic differently from one left out on purpose", () => {
    const { container } = render(
      <EpicsTable
        snapshot={snapshot([
          epic("ACME-10", "Meta loop"),
          epic("ACME-99", "Live-ops tooling"),
        ])}
        baseUrl={SITE}
        hoursPerDay={8}
        project={project()}
        epicMap={{ "ACME-10": "e-meta" }}
      />,
    );
    expect(container.querySelectorAll(".epic-row.mapped")).toHaveLength(1);
    expect(container.querySelectorAll(".epic-row.undecided")).toHaveLength(1);
  });

  it("names plan epics that nothing is mapped to", () => {
    render(
      <EpicsTable
        snapshot={snapshot([epic("ACME-10", "Meta loop")])}
        baseUrl={SITE}
        hoursPerDay={8}
        project={project()}
        epicMap={{ "ACME-10": "e-meta" }}
      />,
    );
    expect(
      screen.getByText(/no Jira epic mapped to them: Shop rework/),
    ).toBeInTheDocument();
  });

  it("counts an epic mapped to 'not in plan' as leaving its plan epic unmapped", () => {
    render(
      <EpicsTable
        snapshot={snapshot([
          epic("ACME-10", "Meta loop"),
          epic("ACME-20", "Shop rework"),
        ])}
        baseUrl={SITE}
        hoursPerDay={8}
        project={project()}
        epicMap={{ "ACME-10": "e-meta", "ACME-20": null }}
      />,
    );
    // ACME-20 exists in Jira but was marked out of scope, so the plan's "Shop
    // rework" still has nothing measuring it.
    expect(
      screen.getByText(/no Jira epic mapped to them: Shop rework/),
    ).toBeInTheDocument();
  });

  it("converts Jira seconds using the tracker's hours-per-day", () => {
    const { rerender } = render(
      <EpicsTable
        snapshot={snapshot([epic("ACME-10", "Meta loop")])}
        baseUrl={SITE}
        hoursPerDay={8}
        epicMap={undefined}
      />,
    );
    // 24h spent is 3 days at 8h, but 4 days at 6h.
    expect(screen.getAllByText("3").length).toBeGreaterThan(0);
    rerender(
      <EpicsTable
        snapshot={snapshot([epic("ACME-10", "Meta loop")])}
        baseUrl={SITE}
        hoursPerDay={6}
        epicMap={undefined}
      />,
    );
    expect(screen.getAllByText("4").length).toBeGreaterThan(0);
  });

  it("says so when the initiative has no epics", () => {
    render(
      <EpicsTable
        snapshot={snapshot([])}
        baseUrl={SITE}
        hoursPerDay={8}
        epicMap={undefined}
      />,
    );
    expect(screen.getByText(/no epics under it/i)).toBeInTheDocument();
  });
});
