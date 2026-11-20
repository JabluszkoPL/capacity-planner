import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AddMemberForm } from "./AddMemberForm";

describe("AddMemberForm", () => {
  it("rejects a blank name inline instead of silently doing nothing", () => {
    const onAdd = vi.fn();
    render(<AddMemberForm onAdd={onAdd} />);
    fireEvent.click(screen.getByRole("button", { name: "Add person" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/enter a name/i);
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("adds a member with the trimmed name + specialization and resets", () => {
    const onAdd = vi.fn();
    render(<AddMemberForm onAdd={onAdd} />);
    const nameInput = screen.getByLabelText("Name") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "  Alice Kim  " } });
    fireEvent.change(screen.getByLabelText("Specialization"), {
      target: { value: " Frontend " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add person" }));

    expect(onAdd).toHaveBeenCalledWith("Alice Kim", "Frontend");
    expect(nameInput.value).toBe("");
  });

  it("clears the error as soon as the user types a name", () => {
    render(<AddMemberForm onAdd={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Add person" }));
    expect(screen.queryByRole("alert")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "B" },
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
