import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NewProjectForm } from "./NewProjectForm";

describe("NewProjectForm", () => {
  it("disables Create until a non-blank name is entered", () => {
    render(<NewProjectForm onCreate={() => {}} />);
    const button = screen.getByRole("button", { name: "Create project" });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "  " },
    });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Roadmap" },
    });
    expect(button).toBeEnabled();
  });

  it("submits the trimmed name and chosen start date, then resets", () => {
    const onCreate = vi.fn();
    render(<NewProjectForm onCreate={onCreate} />);
    const nameInput = screen.getByLabelText("Name") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "  Q4 Roadmap  " } });
    fireEvent.change(screen.getByLabelText("Start date"), {
      target: { value: "2026-09-01" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));

    expect(onCreate).toHaveBeenCalledWith("Q4 Roadmap", "2026-09-01");
    expect(nameInput.value).toBe(""); // form resets after submit
  });

  it("offers Cancel only when given onCancel", () => {
    const { rerender } = render(<NewProjectForm onCreate={() => {}} />);
    expect(
      screen.queryByRole("button", { name: "Cancel" }),
    ).not.toBeInTheDocument();

    const onCancel = vi.fn();
    rerender(<NewProjectForm onCreate={() => {}} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });
});
