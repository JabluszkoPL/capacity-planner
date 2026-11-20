import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { type AppState, toISO } from "@planner/core";
import { AppStoreProvider, useAppStore } from "@planner/client-runtime";
import { ConfirmProvider } from "../ui/ConfirmDialog";
import { MemberRow } from "./MemberRow";

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
      {member && (
        <table>
          <tbody>
            <MemberRow
              member={member}
              offDays={state.teams[0].offDays[member.id]}
            />
          </tbody>
        </table>
      )}
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

describe("MemberRow", () => {
  beforeEach(() => localStorage.clear());

  it("renders an avatar tinted by specialization", () => {
    const { container } = renderChip();
    const avatar = container.querySelector(".avatar") as HTMLElement;
    expect(avatar).toBeTruthy();
    expect(avatar.textContent).toBe("A");
    expect(avatar.style.getPropertyValue("--avatar")).not.toBe("");
  });

  it("shows the next upcoming day off", () => {
    const soon = new Date();
    soon.setDate(soon.getDate() + 3);
    const iso = toISO(soon);
    const state = baseState();
    state.teams[0].offDays = { m1: ["2001-01-01", iso] };
    renderChip(state);
    const months = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
    expect(
      screen.getByText(`${months[soon.getMonth()]} ${soon.getDate()}`),
    ).toBeInTheDocument();
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
