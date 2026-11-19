import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ToastProvider } from "../ui/Toast";
import { ConfirmProvider } from "../ui/ConfirmDialog";
import { Header } from "./Header";

function renderHeader() {
  return render(
    <ToastProvider>
      <ConfirmProvider>
        <MemoryRouter>
          <Header />
        </MemoryRouter>
      </ConfirmProvider>
    </ToastProvider>,
  );
}

describe("Header", () => {
  beforeEach(() => localStorage.clear());

  it("labels each nav link with an icon", () => {
    renderHeader();
    for (const label of ["Projects", "Teams", "Tracking"]) {
      const link = screen.getByRole("link", { name: new RegExp(label) });
      expect(link.textContent).not.toBe(label); // an icon glyph precedes it
    }
  });

  it("opens the Jira settings dialog from the top bar", () => {
    renderHeader();
    expect(screen.queryByText("Jira connection")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Jira/ }));
    expect(screen.getByText("Jira connection")).toBeInTheDocument();
  });

  it("shows a disconnected status dot when Jira isn't configured", () => {
    const { container } = renderHeader();
    const dot = container.querySelector(".jira-dot");
    expect(dot).not.toBeNull();
    expect(dot).not.toHaveClass("connected");
  });
});
