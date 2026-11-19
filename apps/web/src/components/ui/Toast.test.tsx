import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { ToastProvider, ToastHost, useToast } from "./Toast";

function Trigger() {
  const toast = useToast();
  return <button onClick={() => toast("Saved!")}>Fire</button>;
}

function ErrorTrigger() {
  const toast = useToast();
  return (
    <button
      onClick={() =>
        toast("Something broke", { isError: true, context: "extra detail" })
      }
    >
      FireError
    </button>
  );
}

function ManyTrigger() {
  const toast = useToast();
  return (
    <button
      onClick={() => {
        toast("First");
        toast("Second");
        toast("Third");
      }}
    >
      Fire3
    </button>
  );
}

describe("Toast", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows a message and auto-dismisses after ~2s", () => {
    render(
      <ToastProvider>
        <Trigger />
        <ToastHost />
      </ToastProvider>,
    );

    act(() => {
      screen.getByRole("button", { name: "Fire" }).click();
    });
    expect(screen.getByText("Saved!")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.queryByText("Saved!")).not.toBeInTheDocument();
  });

  it("keeps an error toast up twice as long and copies it (with context) to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(
      <ToastProvider>
        <ErrorTrigger />
        <ToastHost />
      </ToastProvider>,
    );

    act(() => {
      screen.getByRole("button", { name: "FireError" }).click();
    });
    expect(screen.getByText("Something broke")).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith("Something broke\n\nextra detail");

    // A plain toast is gone by 2s; an error toast must still be showing.
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByText("Something broke")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.queryByText("Something broke")).not.toBeInTheDocument();
  });

  it("stacks multiple toasts, each independently dismissed", () => {
    render(
      <ToastProvider>
        <ManyTrigger />
        <ToastHost />
      </ToastProvider>,
    );

    act(() => {
      screen.getByRole("button", { name: "Fire3" }).click();
    });
    expect(screen.getByText("First")).toBeInTheDocument();
    expect(screen.getByText("Second")).toBeInTheDocument();
    expect(screen.getByText("Third")).toBeInTheDocument();
    // All three live in the same host container (stacked, not colliding).
    expect(document.querySelectorAll(".toast-host .toast")).toHaveLength(3);

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.queryByText("First")).not.toBeInTheDocument();
  });
});
