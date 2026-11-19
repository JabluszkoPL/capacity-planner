// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TrackerTeam } from "@planner/core";
import { TeamSelector } from "./TeamSelector";

const teams: TrackerTeam[] = [
  { name: "Stars", tasks: 180, plannerTeamId: "t1" },
  { name: "Bulls", tasks: 25, plannerTeamId: null },
];

describe("TeamSelector", () => {
  it("reads every team, merged, when nothing is selected", () => {
    render(<TeamSelector teams={teams} onChange={() => {}} />);
    expect(screen.getByRole("checkbox", { name: /Stars/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Bulls/ })).toBeChecked();
    expect(screen.getByText("All teams, merged.")).toBeInTheDocument();
    expect(screen.getByText("180 tasks")).toBeInTheDocument();
  });

  it("narrows to one team, and stores every team as no selection", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <TeamSelector teams={teams} onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: /Bulls/ }));
    expect(onChange).toHaveBeenLastCalledWith(["Stars"]);

    rerender(
      <TeamSelector teams={teams} selected={["stars"]} onChange={onChange} />,
    );
    // Stored names match whatever the case.
    expect(screen.getByRole("checkbox", { name: /Bulls/ })).not.toBeChecked();
    // The last ticked team cannot be unticked: a reading of nobody means nothing.
    expect(screen.getByRole("checkbox", { name: /Stars/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /Bulls/ }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });
});
