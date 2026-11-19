// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Epic, TaskItem } from "@planner/core";
import { DependencyPicker } from "./DependencyPicker";

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

function Harness({ epics, taskId }: { epics: Epic[]; taskId: string }) {
  const [deps, setDeps] = useState<string[]>([]);
  const all = epics.flatMap((e) => e.tasks);
  const self = { ...all.find((t) => t.id === taskId)!, dependsOn: deps };
  return (
    <>
      <div data-testid="deps">{deps.join(",")}</div>
      <DependencyPicker task={self} allEpics={epics} onChange={setDeps} />
    </>
  );
}

const epics: Epic[] = [
  {
    id: "e1",
    name: "Login",
    tasks: [task("Login API"), task("Login UI"), task("Login QA")],
  },
  { id: "e2", name: "Payments", tasks: [task("Pay API"), task("Pay QA")] },
  { id: "e3", name: "QA", tasks: [task("Regression")] },
];

describe("DependencyPicker", () => {
  it("ticks a whole epic, then lets single tasks be unticked", async () => {
    const user = userEvent.setup();
    render(<Harness epics={epics} taskId="Regression" />);

    await user.click(screen.getByLabelText("All tasks in Login"));
    expect(screen.getByTestId("deps")).toHaveTextContent(
      "Login API,Login UI,Login QA",
    );
    expect(screen.getByLabelText("All tasks in Login")).toBeChecked();

    await user.click(screen.getByLabelText("Login QA"));
    expect(screen.getByTestId("deps")).toHaveTextContent("Login API,Login UI");
    const group = screen.getByLabelText<HTMLInputElement>("All tasks in Login");
    expect(group).not.toBeChecked();
    expect(group.indeterminate).toBe(true);

    // Clicking a partially-selected epic selects the rest of it.
    await user.click(group);
    expect(screen.getByTestId("deps")).toHaveTextContent(
      "Login API,Login UI,Login QA",
    );
    // ...and clicking a fully-selected one clears it.
    await user.click(group);
    expect(screen.getByTestId("deps")).toHaveTextContent("");
  });

  it("select all / clear act on the search matches only", async () => {
    const user = userEvent.setup();
    render(<Harness epics={epics} taskId="Regression" />);

    await user.click(screen.getByRole("button", { name: "Select all" }));
    expect(screen.getByTestId("deps")).toHaveTextContent(
      "Login API,Login UI,Login QA,Pay API,Pay QA",
    );

    await user.type(screen.getByLabelText("Search tasks and epics"), "qa");
    await user.click(screen.getByRole("button", { name: "Clear matching" }));
    expect(screen.getByTestId("deps")).toHaveTextContent(
      "Login API,Login UI,Pay API",
    );
  });

  it("search matching an epic name shows all of that epic's tasks", async () => {
    const user = userEvent.setup();
    render(<Harness epics={epics} taskId="Regression" />);

    await user.type(screen.getByLabelText("Search tasks and epics"), "pay");
    expect(screen.getByLabelText("All tasks in Payments")).toBeInTheDocument();
    expect(screen.getByLabelText("Pay API")).toBeInTheDocument();
    expect(screen.getByLabelText("Pay QA")).toBeInTheDocument();
    expect(screen.queryByLabelText("All tasks in Login")).toBeNull();

    // "log" matches the Login epic, so its QA task shows too.
    await user.clear(screen.getByLabelText("Search tasks and epics"));
    await user.type(screen.getByLabelText("Search tasks and epics"), "log");
    expect(screen.getByLabelText("Login QA")).toBeInTheDocument();
    expect(screen.queryByLabelText("Pay API")).toBeNull();
  });

  it("won't bulk-select a task that already waits on this one", async () => {
    const user = userEvent.setup();
    const looped: Epic[] = [
      {
        id: "e1",
        name: "Login",
        tasks: [task("Login API"), task("Login QA", ["Regression"])],
      },
      { id: "e3", name: "QA", tasks: [task("Regression")] },
    ];
    render(<Harness epics={looped} taskId="Regression" />);

    expect(screen.getByLabelText(/^Login QA/)).toBeDisabled();
    await user.click(screen.getByLabelText("All tasks in Login"));
    expect(screen.getByTestId("deps")).toHaveTextContent("Login API");
    expect(screen.getByLabelText("All tasks in Login")).toBeChecked();
  });
});
