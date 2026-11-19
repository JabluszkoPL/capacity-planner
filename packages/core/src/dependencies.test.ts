import { describe, it, expect } from "vitest";
import type { Epic, TaskItem } from "./types";
import { tasksWaitingOn } from "./dependencies";

function task(id: string, dependsOn?: string[]): TaskItem {
  return {
    id,
    name: id,
    estimateDays: 1,
    specialization: "",
    excluded: false,
    dependsOn,
  };
}

describe("tasksWaitingOn", () => {
  it("is empty when nothing depends on the task", () => {
    const epics: Epic[] = [{ id: "e1", name: "E1", tasks: [task("a")] }];
    expect(tasksWaitingOn(epics, "a")).toEqual(new Set());
  });

  it("follows task dependencies transitively", () => {
    const epics: Epic[] = [
      {
        id: "e1",
        name: "E1",
        tasks: [task("a"), task("b", ["a"]), task("c", ["b"]), task("d")],
      },
    ];
    expect(tasksWaitingOn(epics, "a")).toEqual(new Set(["b", "c"]));
  });

  it("expands an epic dependency to every task in the dependent epic", () => {
    const epics: Epic[] = [
      { id: "e1", name: "E1", tasks: [task("a"), task("b")] },
      {
        id: "e2",
        name: "E2",
        tasks: [task("c"), task("d")],
        dependsOn: ["e1"],
      },
      { id: "e3", name: "E3", tasks: [task("e", ["d"])] },
    ];
    expect(tasksWaitingOn(epics, "a")).toEqual(new Set(["c", "d", "e"]));
  });

  it("never includes the task itself, even inside an existing cycle", () => {
    const epics: Epic[] = [
      { id: "e1", name: "E1", tasks: [task("a", ["b"]), task("b", ["a"])] },
    ];
    expect(tasksWaitingOn(epics, "a")).toEqual(new Set(["b"]));
  });

  it("ignores dangling ids", () => {
    const epics: Epic[] = [
      {
        id: "e1",
        name: "E1",
        tasks: [task("a"), task("b", ["a", "gone"])],
        dependsOn: ["missing"],
      },
    ];
    expect(tasksWaitingOn(epics, "a")).toEqual(new Set(["b"]));
  });
});
