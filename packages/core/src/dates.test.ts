import { describe, it, expect } from "vitest";
import {
  toISO,
  fromISO,
  addDays,
  isWeekend,
  startOfWeek,
  diffDays,
  todayISO,
} from "./dates";

describe("toISO", () => {
  it("formats with zero-padded month and day", () => {
    expect(toISO(new Date(2026, 0, 3))).toBe("2026-01-03");
    expect(toISO(new Date(2026, 11, 25))).toBe("2026-12-25");
  });
});

describe("fromISO", () => {
  it("parses a YYYY-MM-DD string into a local date at midnight", () => {
    const d = fromISO("2026-08-03");
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(7); // August, 0-indexed
    expect(d.getDate()).toBe(3);
    expect(d.getHours()).toBe(0);
  });

  it("round-trips with toISO", () => {
    expect(toISO(fromISO("2026-02-28"))).toBe("2026-02-28");
  });
});

describe("addDays", () => {
  it("adds positive and negative offsets", () => {
    expect(toISO(addDays(fromISO("2026-01-30"), 3))).toBe("2026-02-02");
    expect(toISO(addDays(fromISO("2026-03-01"), -1))).toBe("2026-02-28");
  });

  it("does not mutate the input date", () => {
    const d = fromISO("2026-01-01");
    addDays(d, 10);
    expect(toISO(d)).toBe("2026-01-01");
  });
});

describe("isWeekend", () => {
  it("is true for Saturday and Sunday, false for weekdays", () => {
    // 2026-07-25 is a Saturday, 2026-07-26 a Sunday, 2026-07-27 a Monday.
    expect(isWeekend(fromISO("2026-07-25"))).toBe(true);
    expect(isWeekend(fromISO("2026-07-26"))).toBe(true);
    expect(isWeekend(fromISO("2026-07-27"))).toBe(false);
    expect(isWeekend(fromISO("2026-07-24"))).toBe(false); // Friday
  });
});

describe("startOfWeek", () => {
  it("returns the Monday of the week for any day", () => {
    // Week containing 2026-07-23 (Thursday) starts Monday 2026-07-20.
    expect(toISO(startOfWeek(fromISO("2026-07-23")))).toBe("2026-07-20");
    expect(toISO(startOfWeek(fromISO("2026-07-20")))).toBe("2026-07-20"); // Monday
  });

  it("maps Sunday back to the previous Monday", () => {
    // 2026-07-26 is a Sunday; its week started Monday 2026-07-20.
    expect(toISO(startOfWeek(fromISO("2026-07-26")))).toBe("2026-07-20");
  });

  it("does not mutate the input date", () => {
    const d = fromISO("2026-07-23");
    startOfWeek(d);
    expect(toISO(d)).toBe("2026-07-23");
  });
});

describe("diffDays", () => {
  it("returns the whole-day difference b - a", () => {
    expect(diffDays(fromISO("2026-01-01"), fromISO("2026-01-11"))).toBe(10);
    expect(diffDays(fromISO("2026-01-11"), fromISO("2026-01-01"))).toBe(-10);
    expect(diffDays(fromISO("2026-01-01"), fromISO("2026-01-01"))).toBe(0);
  });

  it("stays correct across a DST boundary", () => {
    // US DST starts 2026-03-08. Rounding keeps this a clean integer.
    expect(diffDays(fromISO("2026-03-07"), fromISO("2026-03-09"))).toBe(2);
  });
});

describe("todayISO", () => {
  it("returns a well-formed YYYY-MM-DD string", () => {
    expect(todayISO()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
