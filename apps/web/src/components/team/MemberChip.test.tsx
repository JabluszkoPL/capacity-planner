import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { AppState } from "@planner/core";
import { AppStoreProvider, useAppStore } from "@planner/client-runtime";
import { ConfirmProvider } from "../ui/ConfirmDialog";
import { MemberChip } from "./MemberChip";

function baseState(): AppState {
  return {
    projects: [],
    teams: [
      {
        id: "t1",
        name: "Team 1",
        members: [{ id: "m1", name: "Alice", specialization: "Frontend" }],
        offDays: { m1: ["2026-08-03", "2026-08-04"] },
      },
    ],
  };
}

function Harness() {
  const { state } = useAppStore();
  const member = state.teams[0].members.find((m) => m.id === "m1");
  return (
    <>
      <div data-testid="member-name">{member?.name ?? "(gone)"}</div>
      <div data-testid="offday-keys">
        {Object.keys(state.teams[0].offDays).join(",")}
      </div>
      {member && <MemberChip member={member} />}
    </>
  );
}

function renderChip(initial = baseState()) {
  return render(
    <ConfirmProvider>
      <AppStoreProvider initial={initial}>
        <Harness />
      </AppStoreProvider>
    </ConfirmProvider>,
  );
}

describe("MemberChip", () => {
  beforeEach(() => localStorage.clear());

  it("renders a colored swatch", () => {
    const { container } = renderChip();
    const swatch = container.querySelector(".swatch") as HTMLElement;
    expect(swatch).toBeTruthy();
    expect(swatch.style.background).not.toBe("");
  });

  it("commits a renamed member on blur", () => {
    renderChip();
    const input = screen.getByLabelText("Member name");
    fireEvent.change(input, { target: { value: "Alicia" } });
    expect(screen.getByTestId("member-name")).toHaveTextContent("Alice");
    fireEvent.blur(input);
    expect(screen.getByTestId("member-name")).toHaveTextContent("Alicia");
  });

  it("reverts a blank name rather than saving it", () => {
    renderChip();
    const input = screen.getByLabelText("Member name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.blur(input);
    expect(screen.getByTestId("member-name")).toHaveTextContent("Alice");
    expect(input.value).toBe("Alice");
  });

  it("deletes the member (with confirm) and drops their off-days", async () => {
    renderChip();
    expect(screen.getByTestId("offday-keys")).toHaveTextContent("m1");

    fireEvent.click(screen.getByRole("button", { name: "Remove Alice" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    await waitFor(() =>
      expect(screen.getByTestId("member-name")).toHaveTextContent("(gone)"),
    );
    // Their off-day records are gone from the store too.
    expect(screen.getByTestId("offday-keys")).toHaveTextContent("");
  });
});
