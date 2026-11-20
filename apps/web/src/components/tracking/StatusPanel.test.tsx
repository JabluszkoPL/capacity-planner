import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { SpecializationStatus, TrackerStatus } from "@planner/core";
import {
  StatusPanel,
  peopleLateSum,
  peopleLateText,
  specializationLabel,
  statusLabel,
  suspiciousLead,
} from "./StatusPanel";

function status(overrides: Partial<TrackerStatus> = {}): TrackerStatus {
  return {
    kind: "on-plan",
    today: "2026-09-21",
    plannedDays: 32,
    earnedDays: 32,
    varianceDays: 0,
    bufferDays: 20,
    bufferUsedDays: 0,
    overrunDays: 0,
    effortBufferDays: 17,
    roundingBufferDays: 1.5,
    unbufferedEnd: "2026-11-27",
    bufferedEnd: "2026-12-25",
    projectedFinish: "2026-11-27",
    marginDays: 20,
    jiraSetDays: 118,
    jiraSpentDays: 41,
    jiraRemainingDays: 61,
    planRemainingDays: 68,
    bySpecialization: [],
    deadline: "2026-12-25",
    deadlineKind: "end",
    deadlines: null,
    scope: "all",
    window: null,
    ...overrides,
  };
}

describe("statusLabel", () => {
  it("names the buffer share when the buffer is being used", () => {
    const label = statusLabel(
      status({ kind: "using-buffer", varianceDays: -5, bufferUsedDays: 5 }),
    );
    expect(label.text).toBe(
      "5 days behind the finish without buffer · using 5 of 20 buffer days (25%)",
    );
    expect(label.tone).toBe("warn");
  });

  it("reports being ahead with the number of days", () => {
    expect(statusLabel(status({ kind: "ahead", varianceDays: 2 })).text).toBe(
      "2 days ahead of the finish without buffer",
    );
  });

  it("says buffer exhausted only when there was a buffer to exhaust", () => {
    expect(
      statusLabel(
        status({ kind: "over-buffer", overrunDays: 3, varianceDays: -23 }),
      ).text,
    ).toBe("Buffer used up · 3 days late for the end date");
    expect(
      statusLabel(
        status({ kind: "over-buffer", overrunDays: 3, bufferDays: 0 }),
      ).text,
    ).toBe("3 days late for the end date");
  });

  it("gives every status a glyph as well as a colour", () => {
    // Colour must never be the only carrier of meaning.
    for (const kind of [
      "ahead",
      "on-plan",
      "using-buffer",
      "over-buffer",
      "no-baseline",
    ] as const) {
      const label = statusLabel(status({ kind }));
      expect(label.glyph).not.toBe("");
      expect(label.text).not.toBe("");
    }
  });
});

describe("StatusPanel", () => {
  it("shows the plan facts when a comparison is possible", () => {
    render(
      <StatusPanel
        status={status({
          kind: "using-buffer",
          varianceDays: -5,
          bufferUsedDays: 5,
          projectedFinish: "2026-12-04",
        })}
      />,
    );
    expect(
      screen.getByText(/using 5 of 20 buffer days \(25%\)/),
    ).toBeInTheDocument();
    expect(screen.getByText("2026-12-04")).toBeInTheDocument();
    expect(screen.getByText("Projected finish")).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: /25% of the buffer used/i }),
    ).toBeInTheDocument();
  });

  it("offers to count tasks past In Progress as done", () => {
    const onChange = vi.fn();
    const { rerender } = render(<StatusPanel status={status()} />);
    expect(screen.queryByRole("checkbox")).toBeNull();
    rerender(
      <StatusPanel
        status={status()}
        pastInProgress={{ checked: false, onChange }}
      />,
    );
    const box = screen.getByRole("checkbox", {
      name: /Count tasks past To Do and In Progress as done/,
    });
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("explains what is missing instead of showing plan numbers", () => {
    render(
      <StatusPanel
        status={status({
          kind: "no-baseline",
          reason: "No baseline project is linked to this tracker.",
        })}
      >
        <p>pick one</p>
      </StatusPanel>,
    );
    expect(
      screen.getByText("No baseline project is linked to this tracker."),
    ).toBeInTheDocument();
    expect(screen.getByText("pick one")).toBeInTheDocument();
    expect(screen.queryByText("Projected finish")).not.toBeInTheDocument();
    // Jira's own numbers are still worth showing without a plan.
    expect(screen.getByText("Jira remaining")).toBeInTheDocument();
  });

  it("warns when the baseline plan no longer matches the project", () => {
    render(
      <StatusPanel
        status={status()}
        planStale={{ storedEnd: "2026-12-04", currentEnd: "2026-12-25" }}
      />,
    );
    expect(
      screen.getByText(
        /project page is out of date: it finishes 2026-12-04, .* it finishes 2026-12-25/,
      ),
    ).toBeInTheDocument();
  });

  it("labels the meter as fully spent once the buffer is gone", () => {
    render(
      <StatusPanel
        status={status({
          kind: "over-buffer",
          varianceDays: -23,
          bufferUsedDays: 20,
          overrunDays: 3,
        })}
      />,
    );
    expect(
      screen.getByRole("img", { name: /3 days beyond it/i }),
    ).toBeInTheDocument();
  });
});

describe("suspiciousLead", () => {
  it("flags a lead built on far more earned than planned", () => {
    expect(
      suspiciousLead(
        status({ kind: "ahead", plannedDays: 10, earnedDays: 30 }),
      ),
    ).toBe(true);
    expect(
      suspiciousLead(
        status({ kind: "ahead", plannedDays: 30, earnedDays: 36 }),
      ),
    ).toBe(false);
    expect(
      suspiciousLead(
        status({ kind: "on-plan", plannedDays: 0, earnedDays: 0 }),
      ),
    ).toBe(false);
  });

  it("is shown in the panel with the numbers behind it", () => {
    render(
      <StatusPanel
        status={status({
          kind: "ahead",
          varianceDays: 27,
          plannedDays: 4,
          earnedDays: 30,
        })}
      />,
    );
    expect(screen.getByText(/expected only 4 by today/)).toBeInTheDocument();
  });
});

describe("end date line", () => {
  it("says how many days are left before the end date", () => {
    expect(
      statusLabel(status({ kind: "ahead", varianceDays: 27, marginDays: 47 }))
        .endDate,
    ).toBe("End date 2026-12-25 · 47 days to spare");
  });

  it("says how late the projection lands when it misses", () => {
    expect(
      statusLabel(
        status({
          kind: "over-buffer",
          overrunDays: 3,
          marginDays: -3,
          projectedFinish: "2026-12-30",
        }),
      ).endDate,
    ).toBe("End date 2026-12-25 · projected 3 days late (2026-12-30)");
  });

  it("is absent without a baseline", () => {
    expect(
      statusLabel(status({ kind: "no-baseline" })).endDate,
    ).toBeUndefined();
  });
});

describe("by specialization", () => {
  const row = (over: Partial<SpecializationStatus>): SpecializationStatus => ({
    specialization: "dev",
    kind: "on-plan",
    plannedDays: 30,
    earnedDays: 30,
    totalDays: 100,
    varianceDays: 0,
    firstStart: "2026-09-07",
    unbufferedEnd: "2026-11-27",
    projectedFinish: "2026-11-27",
    marginDays: 20,
    bufferDays: 20,
    unestimatedTasks: 0,
    ...over,
  });

  it("words each kind, naming what it is measured against", () => {
    expect(
      specializationLabel(row({ kind: "ahead", varianceDays: 3 })).text,
    ).toBe("3 days ahead of the plan without buffer");
    expect(
      specializationLabel(
        row({ kind: "behind", varianceDays: -5, marginDays: 15 }),
      ).text,
    ).toBe("Using 5 of 20 buffer days (25%) · 15 days left");
    expect(
      specializationLabel(
        row({ kind: "behind", varianceDays: -1, bufferDays: 0 }),
      ).text,
    ).toBe("1 day behind");
    // 18 behind with 15 of buffer: what matters is the 3 days after it.
    expect(
      specializationLabel(
        row({
          kind: "late",
          varianceDays: -18,
          bufferDays: 15,
          marginDays: -3,
        }),
        "the end of development",
      ).text,
    ).toBe(
      "3 days late for the end of development · all 15 buffer days used (100%)",
    );
    expect(
      specializationLabel(
        row({ kind: "late", varianceDays: -3, bufferDays: 0, marginDays: -3 }),
      ).text,
    ).toBe("3 days late for its deadline");
    expect(
      specializationLabel(row({ kind: "late", varianceDays: 0 })).text,
    ).toBe("On pace, but the plan finishes after its deadline");
    expect(
      specializationLabel(
        row({ kind: "not-started", firstStart: "2026-12-01" }),
      ).text,
    ).toBe("Not started yet · starts 2026-12-01");
    expect(specializationLabel(row({ kind: "unscheduled" })).tone).toBe("bad");
  });

  it("shows a table when there is more than one specialization", () => {
    render(
      <StatusPanel
        status={status({
          bySpecialization: [
            row({
              specialization: "qa",
              kind: "late",
              varianceDays: -25,
              marginDays: -5,
            }),
            row({
              specialization: "dev",
              kind: "ahead",
              varianceDays: 3,
              marginDays: 23,
            }),
          ],
        })}
      />,
    );
    expect(screen.getByRole("rowheader", { name: "qa" })).toBeInTheDocument();
    expect(screen.getByText("5 days late")).toBeInTheDocument();
    expect(screen.getByText("23 days to spare")).toBeInTheDocument();
  });

  it("hides the table for a single specialization, which the headline covers", () => {
    render(<StatusPanel status={status({ bySpecialization: [row({})] })} />);
    expect(screen.queryByText("By specialization")).not.toBeInTheDocument();
  });
});

describe("with an end of development", () => {
  const devEnd = {
    startDate: "2026-09-07",
    startFromPlan: true,
    planStartDate: "2026-09-07",
    endDate: "2026-12-25",
    endDateFromPlan: false,
    planEndDate: "2026-12-25",
    devEndDate: "2026-12-11",
    devEndFromPlan: true,
    planDevEndDate: "2026-12-11",
    endPhase: ["QA"],
  };

  it("names the end of development in the headline and the line under it", () => {
    const s = status({
      kind: "over-buffer",
      varianceDays: -12,
      bufferDays: 10,
      overrunDays: 2,
      marginDays: -2,
      projectedFinish: "2026-12-15",
      deadline: "2026-12-11",
      deadlineKind: "dev-end",
      deadlines: devEnd,
      scope: "development",
    });
    const label = statusLabel(s);
    expect(label.text).toBe(
      "Buffer used up · 2 days late for the end of development",
    );
    expect(label.endDate).toBe(
      "Development ends 2026-12-11 · projected 2 days late (2026-12-15)",
    );
  });

  it("schedules QA back from the end date, in your example's terms", () => {
    // End date 150 working days away, 100 days of QA work: 50 to spare.
    render(
      <StatusPanel
        status={status({
          deadline: "2026-12-11",
          deadlineKind: "dev-end",
          deadlines: devEnd,
          scope: "development",
          bySpecialization: [
            {
              specialization: "QA",
              kind: "ahead",
              plannedDays: 0,
              earnedDays: 0,
              totalDays: 100,
              varianceDays: 50,
              firstStart: "2027-02-01",
              unbufferedEnd: "2027-04-23",
              projectedFinish: "2027-02-12",
              marginDays: 50,
              bufferDays: 0,
              unestimatedTasks: 4,
              phase: {
                mustStartBy: "2027-02-01",
                latestStart: "2027-02-22",
                to: "2027-04-23",
                bufferDays: 15,
                capacityDays: 150,
                remainingDays: 100,
                overlapsDevelopment: false,
                schedule: [
                  {
                    taskId: "q1",
                    name: "Regression pass",
                    estimateDays: 100,
                    days: 120,
                    start: "2027-02-01",
                    end: "2027-04-23",
                    done: false,
                  },
                ],
              },
            },
            {
              specialization: "Backend",
              kind: "behind",
              plannedDays: 30,
              earnedDays: 25,
              totalDays: 60,
              varianceDays: -3,
              firstStart: "2026-09-07",
              unbufferedEnd: "2026-12-04",
              projectedFinish: "2026-12-09",
              marginDays: 2,
              bufferDays: 2,
              unestimatedTasks: 0,
            },
          ],
        })}
      />,
    );
    expect(
      screen.getByText("50 days ahead · must start by 2027-02-01"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /must start by 2027-02-01 with buffer · 2027-02-22 at the latest/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("starts 2027-02-01, ends 2027-04-23"),
    ).toBeInTheDocument();
    // The schedule lists every task with its dates.
    expect(screen.getByText("Regression pass")).toBeInTheDocument();
    expect(
      screen.getByText(
        /needs 100 of the 150 person-days left before the end date/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("50 days to spare")).toBeInTheDocument();
    expect(screen.getByText(/4 tasks without an estimate/)).toBeInTheDocument();
    expect(screen.getByText("Development ends (plan)")).toBeInTheDocument();
  });

  it("warns when QA has to start before development ends", () => {
    render(
      <StatusPanel
        status={status({
          deadline: "2026-12-11",
          deadlineKind: "dev-end",
          deadlines: devEnd,
          scope: "development",
          bySpecialization: [
            {
              specialization: "QA",
              kind: "ahead",
              plannedDays: 0,
              earnedDays: 0,
              totalDays: 20,
              varianceDays: 30,
              firstStart: "2026-11-27",
              unbufferedEnd: "2026-12-25",
              projectedFinish: "2026-10-20",
              marginDays: 30,
              bufferDays: 0,
              unestimatedTasks: 0,
              phase: {
                mustStartBy: "2026-11-27",
                latestStart: "2026-12-01",
                to: "2026-12-25",
                bufferDays: 2,
                capacityDays: 50,
                remainingDays: 20,
                overlapsDevelopment: true,
                schedule: [],
              },
            },
            {
              specialization: "Backend",
              kind: "on-plan",
              plannedDays: 30,
              earnedDays: 30,
              totalDays: 60,
              varianceDays: 0,
              firstStart: "2026-09-07",
              unbufferedEnd: "2026-12-04",
              projectedFinish: "2026-12-04",
              marginDays: 5,
              bufferDays: 5,
              unestimatedTasks: 0,
            },
          ],
        })}
      />,
    );
    expect(
      screen.getByText("has to start before development ends (2026-12-11)"),
    ).toBeInTheDocument();
  });
});

describe("re-timed to custom dates", () => {
  it("says the finish without buffer comes from your dates", () => {
    const s = status({
      kind: "using-buffer",
      varianceDays: -7.5,
      bufferUsedDays: 7.5,
      bufferDays: 18,
      unbufferedEnd: "2027-01-12",
      projectedFinish: "2027-01-22",
      marginDays: 10,
      deadline: "2027-02-05",
      deadlineKind: "dev-end",
      scope: "development",
      window: { from: "2026-09-07", to: "2027-02-05", bufferPct: 20 },
    });
    render(<StatusPanel status={s} />);
    expect(
      screen.getByText("Development finish without buffer (your dates)"),
    ).toBeInTheDocument();
  });
});

describe("the specialization that finishes last", () => {
  const spec = (over: Partial<SpecializationStatus>): SpecializationStatus => ({
    specialization: "Client",
    kind: "late",
    plannedDays: 219.3,
    earnedDays: 158,
    totalDays: 219.3,
    varianceDays: -18,
    firstStart: "2026-09-07",
    unbufferedEnd: "2026-11-09",
    projectedFinish: "2026-12-03",
    marginDays: -3,
    bufferDays: 15,
    unestimatedTasks: 0,
    ...over,
  });

  it("is named in the variance, and sets the headline", () => {
    const s = status({
      kind: "over-buffer",
      varianceDays: -18,
      bufferDays: 15,
      bufferUsedDays: 15,
      overrunDays: 3,
      marginDays: -3,
      projectedFinish: "2026-12-03",
      deadline: "2026-11-30",
      deadlineKind: "dev-end",
      critical: "Client",
      bySpecialization: [
        spec({}),
        spec({
          specialization: "Backend",
          kind: "behind",
          varianceDays: -13.3,
          bufferDays: 13.3,
          marginDays: 0,
        }),
      ],
    });
    expect(statusLabel(s).text).toBe(
      "Buffer used up · 3 days late for the end of development",
    );
    render(<StatusPanel status={s} />);
    expect(
      screen.getByText("Variance (Client, vs. finish without buffer)"),
    ).toBeInTheDocument();
  });

  it("puts the past-In-Progress option beside the view tabs", () => {
    const s = status({
      bySpecialization: [spec({}), spec({ specialization: "Backend" })],
    });
    render(
      <StatusPanel
        status={s}
        pastInProgress={{ checked: false, onChange: vi.fn() }}
      />,
    );
    const views = screen.getByRole("region", { name: "By specialization" });
    expect(
      within(views).getByRole("checkbox", {
        name: /Count tasks past To Do and In Progress as done/,
      }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
  });

  it("is not named when it is the only one", () => {
    const s = status({
      kind: "over-buffer",
      critical: "Client",
      bySpecialization: [spec({})],
    });
    render(<StatusPanel status={s} />);
    expect(
      screen.getByText("Variance (vs. finish without buffer)"),
    ).toBeInTheDocument();
  });
});

describe("waiting to be closed", () => {
  it("lists the queue by status and what closing it today would buy", () => {
    const now = status({
      kind: "over-buffer",
      marginDays: -3,
      overrunDays: 3,
      projectedFinish: "2026-12-03",
      deadline: "2026-11-30",
      deadlineKind: "dev-end",
    });
    const closed = status({
      kind: "using-buffer",
      varianceDays: -12,
      bufferDays: 15,
      bufferUsedDays: 12,
      marginDays: 3,
      projectedFinish: "2026-11-25",
      deadline: "2026-11-30",
      deadlineKind: "dev-end",
    });
    render(
      <StatusPanel
        status={now}
        awaitingClose={{
          tasks: 5,
          days: 12.5,
          bySpecialization: [],
          statuses: [
            { status: "Review", tasks: 3, days: 8 },
            { status: "Ready", tasks: 2, days: 4.5 },
          ],
          closed,
        }}
      />,
    );
    expect(screen.getByText("5 tasks · 12.5 d")).toBeInTheDocument();
    expect(
      screen.getByText(/Review 3 \(8 d\) · Ready 2 \(4\.5 d\)/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /projected finish 2026-11-25 instead of 2026-12-03, 6 working days sooner/,
      ),
    ).toBeInTheDocument();
  });

  it("puts each specialization's queue on its row, with what closing it does", () => {
    const row = (
      over: Partial<SpecializationStatus>,
    ): SpecializationStatus => ({
      specialization: "Client",
      kind: "late",
      plannedDays: 30,
      earnedDays: 20,
      totalDays: 100,
      varianceDays: -18,
      firstStart: "2026-09-07",
      unbufferedEnd: "2026-11-09",
      projectedFinish: "2026-12-03",
      marginDays: -3,
      bufferDays: 15,
      unestimatedTasks: 0,
      ...over,
    });
    const now = status({
      kind: "over-buffer",
      marginDays: -3,
      deadline: "2026-11-30",
      deadlineKind: "dev-end",
      bySpecialization: [
        row({
          peopleLate: { overflowDays: 9, days: 3, people: 3, perDay: 3 },
        }),
        row({ specialization: "Backend", kind: "behind", marginDays: 0 }),
      ],
    });
    render(
      <StatusPanel
        status={now}
        awaitingClose={{
          tasks: 4,
          days: 10,
          statuses: [{ status: "Review", tasks: 4, days: 10 }],
          bySpecialization: [
            {
              specialization: "Client",
              tasks: 4,
              days: 10,
              people: 3,
              workingDays: 3.33,
            },
          ],
          closed: status({
            kind: "using-buffer",
            bySpecialization: [row({ kind: "behind", marginDays: 2 })],
          }),
        }}
      />,
    );
    const client = screen.getByRole("row", { name: /^Client/ });
    expect(
      within(client).getByText(
        "9 plan days won't fit before the end of development, split across its 3 people: 3 working days after it",
      ),
    ).toBeInTheDocument();
    expect(
      within(client).getByText(
        /4 tasks \(10 d\) waiting to be closed · closed today: 2 days to spare/,
      ),
    ).toBeInTheDocument();
    // In the deadline column, how late as the sum it is.
    expect(within(client).getByText("9 d ÷ 3 people = 3")).toBeInTheDocument();
    // In the deadline column: 10 plan days across 3 people.
    expect(
      within(client).getByText("3.3 days waiting to be closed"),
    ).toBeInTheDocument();
    expect(within(client).getByText("10 d ÷ 3 people")).toBeInTheDocument();
    const backend = screen.getByRole("row", { name: /^Backend/ });
    expect(within(backend).queryByText(/waiting to be closed/)).toBeNull();
  });

  it("is absent without a queue", () => {
    render(<StatusPanel status={status({})} awaitingClose={null} />);
    expect(screen.queryByText("Waiting to be closed")).toBeNull();
  });
});

describe("a reading of some teams", () => {
  it("says which teams and what it leaves out", () => {
    render(
      <StatusPanel
        status={status({
          teamScope: {
            teamNames: ["Stars"],
            peopleFrom: ["Stars"],
            otherTeamTasks: 12,
            noTeamTasks: 2,
            planTasksLeftOut: 4,
          },
        })}
      />,
    );
    expect(screen.getByText("Stars only.")).toBeInTheDocument();
    expect(
      screen.getByText(
        /Left out: 12 Jira tasks of other teams; 4 plan tasks no Jira task of theirs maps to\./,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/2 Jira tasks with no team in Jira/),
    ).toBeInTheDocument();
  });
});

describe("how late, as a sum", () => {
  it("shows the daily rate when speeds are not 1, and the rounding up", () => {
    // Backend: 11.6 days over, two people at 0.85 = 1.7 a day.
    expect(
      peopleLateSum({ overflowDays: 11.6, days: 7, people: 2, perDay: 1.7 }),
    ).toBe("11.6 d ÷ 2 people at 1.7 d a day = 6.8 → 7");
    expect(
      peopleLateSum({ overflowDays: 11.6, days: 6, people: 2, perDay: 2 }),
    ).toBe("11.6 d ÷ 2 people = 5.8 → 6");
    // Longer than the sum: days off in between.
    expect(
      peopleLateSum({ overflowDays: 4, days: 4, people: 2, perDay: 2 }),
    ).toBe("4 d ÷ 2 people = 2 → 4 (days off)");
  });
});

describe("finish counted by people", () => {
  const row = (over: Partial<SpecializationStatus>): SpecializationStatus => ({
    specialization: "Client",
    kind: "behind",
    plannedDays: 187,
    earnedDays: 170.3,
    totalDays: 187,
    varianceDays: -14,
    firstStart: "2026-06-01",
    unbufferedEnd: "2026-11-06",
    projectedFinish: "2026-11-27",
    marginDays: 1,
    bufferDays: 15,
    unestimatedTasks: 0,
    ...over,
  });

  it("names the day the work is done when it fits", () => {
    const r = row({
      peopleLate: {
        overflowDays: 0,
        days: 0,
        people: 3,
        perDay: 3,
        finish: "2026-11-27",
      },
    });
    expect(peopleLateText(r, "the end of development")).toBe(
      "counted by its people, the work left is done by 2026-11-27, before the end of development",
    );
    expect(specializationLabel(r).text).toBe(
      "Using 14 of 15 buffer days (93%) · 1 day left",
    );
  });

  it("says when that is even before the finish without buffer", () => {
    const r = row({
      kind: "on-plan",
      varianceDays: 0,
      projectedFinish: "2026-11-06",
      marginDays: 15,
      peopleLate: {
        overflowDays: 0,
        days: 0,
        people: 3,
        perDay: 3,
        finish: "2026-11-02",
      },
    });
    expect(peopleLateText(r, "the end of development")).toBe(
      "counted by its people, the work left is done by 2026-11-02, before its finish without buffer (2026-11-06)",
    );
  });
});

describe("QA using its buffer", () => {
  it("says how much of QA's buffer a delay spends", () => {
    expect(
      specializationLabel({
        specialization: "QA",
        kind: "behind",
        plannedDays: 5,
        earnedDays: 0,
        totalDays: 20,
        varianceDays: -3,
        firstStart: "2026-11-27",
        unbufferedEnd: "2026-12-25",
        projectedFinish: "2026-12-25",
        marginDays: 1,
        bufferDays: 4,
        unestimatedTasks: 0,
        phase: {
          mustStartBy: "2026-11-27",
          latestStart: "2026-12-03",
          to: "2026-12-25",
          bufferDays: 4,
          capacityDays: 20,
          remainingDays: 20,
          overlapsDevelopment: false,
          schedule: [],
        },
      }).text,
    ).toBe("Using 3 of 4 buffer days (75%) · 1 day left");
  });
});
