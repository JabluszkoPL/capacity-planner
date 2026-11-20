import { describe, it, expect } from "vitest";
import type { ForecastItem, RemainingWork } from "./forecast";
import { sprintWorkdays, sprintsFor } from "./sprintForecast";

const item = (taskId: string, end: string, estimateDays: number) =>
  ({ taskId, end, estimateDays }) as ForecastItem;

const work = (items: ForecastItem[]): RemainingWork =>
  ({
    items,
    finish: items.reduce<string | null>(
      (max, a) => (max === null || a.end > max ? a.end : max),
      null,
    ),
  }) as RemainingWork;

describe("sprintsFor", () => {
  it("lays two-week sprints from the start until the last task finishes", () => {
    // Monday 2026-11-23; sprints end on the Friday before the next starts.
    const plan = sprintsFor(
      work([
        item("a", "2026-11-27", 3),
        item("b", "2026-12-04", 2),
        item("c", "2026-12-07", 1.5),
        item("d", "2026-12-21", 4),
      ]),
      "2026-11-23",
      2,
    );
    expect(
      plan.sprints.map((s) => [
        s.number,
        s.start,
        s.end,
        s.items.length,
        s.days,
      ]),
    ).toEqual([
      [1, "2026-11-23", "2026-12-04", 2, 5],
      [2, "2026-12-07", "2026-12-18", 1, 1.5],
      [3, "2026-12-21", "2027-01-01", 1, 4],
    ]);
    expect(plan.finish).toBe("2026-12-21");
  });

  it("gives one empty sprint when nothing is left", () => {
    const plan = sprintsFor(work([]), "2026-11-23", 1);
    expect(plan.sprints).toHaveLength(1);
    expect(plan.sprints[0]).toMatchObject({
      start: "2026-11-23",
      end: "2026-11-27",
      items: [],
      days: 0,
    });
    expect(plan.finish).toBeNull();
  });

  it("counts five working days a week", () => {
    expect([1, 2, 3].map(sprintWorkdays)).toEqual([5, 10, 15]);
  });
});
