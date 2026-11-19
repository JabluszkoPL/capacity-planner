import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { Modal } from "./Modal";

describe("Modal", () => {
  it("renders its children only when open", () => {
    const { rerender } = render(
      <Modal open={false} onClose={() => {}}>
        <p>Body content</p>
      </Modal>,
    );
    expect(screen.queryByText("Body content")).not.toBeInTheDocument();

    rerender(
      <Modal open onClose={() => {}}>
        <p>Body content</p>
      </Modal>,
    );
    expect(screen.getByText("Body content")).toBeInTheDocument();
  });

  it("closes on a genuine backdrop click", () => {
    const onClose = vi.fn();
    const { container } = render(
      <Modal open onClose={onClose}>
        <p>Body content</p>
      </Modal>,
    );
    const backdrop = container.querySelector(".modal-backdrop")!;
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does NOT close when a click bubbles up from content inside the panel", () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose}>
        <p>Body content</p>
        <button>Inside button</button>
      </Modal>,
    );
    // Plain text/content click — the POC regression that made buttons dead.
    fireEvent.click(screen.getByText("Body content"));
    expect(onClose).not.toHaveBeenCalled();
    // A real button inside the panel still works and does not close the modal.
    fireEvent.click(screen.getByRole("button", { name: "Inside button" }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose}>
        <p>Body content</p>
      </Modal>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("returns focus to the previously focused element on close", () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Open</button>
          <Modal open={open} onClose={() => setOpen(false)}>
            <button>Inside</button>
          </Modal>
        </>
      );
    }
    render(<Harness />);
    const openBtn = screen.getByRole("button", { name: "Open" });
    openBtn.focus();
    expect(openBtn).toHaveFocus();

    fireEvent.click(openBtn);
    // Focus moved into the modal.
    expect(screen.getByRole("button", { name: "Inside" })).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    // Focus returns to the trigger.
    expect(openBtn).toHaveFocus();
  });
});
