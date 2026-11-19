import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ComboInput } from "./ComboInput";

function Harness({
  initial = "",
  onCommit = () => {},
}: {
  initial?: string;
  onCommit?: (v: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <ComboInput
      aria-label="Spec"
      value={value}
      options={["Backend", "Frontend", "QA"]}
      onChange={setValue}
      onCommit={onCommit}
    />
  );
}

const shown = () => screen.getAllByRole("option").map((o) => o.textContent);

describe("ComboInput", () => {
  it("opens the full list on click even when a value is set", async () => {
    const user = userEvent.setup();
    render(<Harness initial="Backend" />);
    await user.click(screen.getByRole("combobox"));
    expect(shown()).toEqual(["Backend", "Frontend", "QA"]);
    expect(screen.getByRole("option", { name: "Backend" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("filters once the user types", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByRole("combobox"), "end");
    expect(shown()).toEqual(["Backend", "Frontend"]);
  });

  it("picks with the arrow keys and Enter, committing the option", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);
    const input = screen.getByRole("combobox");
    await user.click(input);
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(input).toHaveValue("Frontend");
    expect(onCommit).toHaveBeenCalledWith("Frontend");
    expect(input).toHaveFocus();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("Escape closes the list and keeps the typed text", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);
    const input = screen.getByRole("combobox");
    await user.type(input, "Q");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(input).toHaveValue("Q");
    expect(input).toHaveFocus();
    await user.tab();
    expect(onCommit).toHaveBeenLastCalledWith("Q");
  });
});
