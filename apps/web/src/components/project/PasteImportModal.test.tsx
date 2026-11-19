import { describe, it, expect, beforeEach } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { AppState } from "@planner/core";
import { AppStoreProvider, useAppStore } from "@planner/client-runtime";
import { ConfirmProvider } from "../ui/ConfirmDialog";
import { ToastProvider, ToastHost } from "../ui/Toast";
import { EpicList } from "./EpicList";
import { PasteImportModal } from "./PasteImportModal";

function initialState(): AppState {
  return {
    projects: [
      {
        id: "p1",
        name: "P",
        startDate: "2026-07-27",
        plan: null,
        planViewMode: "person",
        epics: [{ id: "e1", name: "Onboarding", tasks: [] }],
      },
    ],
    teams: [{ id: "t1", name: "Team 1", members: [], offDays: {} }],
  };
}

/** Renders the modal next to the real T06 editor so we can assert imports
 *  show up in the editor immediately. */
function Inner() {
  const { state } = useAppStore();
  const project = state.projects[0];
  const [open, setOpen] = useState(true);
  return (
    <>
      <EpicList project={project} />
      <PasteImportModal
        open={open}
        onClose={() => setOpen(false)}
        project={project}
      />
    </>
  );
}

function renderModal(initial = initialState()) {
  return render(
    <ToastProvider>
      <ConfirmProvider>
        <AppStoreProvider initial={initial}>
          <Inner />
        </AppStoreProvider>
        <ToastHost />
      </ConfirmProvider>
    </ToastProvider>,
  );
}

describe("PasteImportModal", () => {
  beforeEach(() => localStorage.clear());

  it("does not close when a plain click bubbles from content inside the modal (POC regression)", () => {
    renderModal();
    // Click the hint text — this exact case broke the reference POC.
    fireEvent.click(screen.getByText(/Paste rows copied from a spreadsheet/i));
    expect(screen.getByLabelText("Pasted rows")).toBeInTheDocument();
  });

  it("Cancel closes the modal", () => {
    renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Pasted rows")).not.toBeInTheDocument();
  });

  it("shows a clear message and stays open when no rows are recognized", () => {
    renderModal();
    fireEvent.change(screen.getByLabelText("Pasted rows"), {
      target: { value: "###\nnonsense" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(screen.getByText(/No rows recognized/i)).toBeInTheDocument();
    // Still open.
    expect(screen.getByLabelText("Pasted rows")).toBeInTheDocument();
  });

  it("imports rows into existing and new epics, and they appear in the editor", async () => {
    renderModal();
    fireEvent.change(screen.getByLabelText("Pasted rows"), {
      target: {
        value:
          "Onboarding\tSet up SSO\t3\tBackend\nPayments\tCheckout\t4\tFrontend",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    // Modal closed + toast reported the count.
    await waitFor(() =>
      expect(screen.queryByLabelText("Pasted rows")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Imported 2 tasks.")).toBeInTheDocument();

    // Tasks are visible in the T06 editor immediately.
    expect(screen.getByDisplayValue("Set up SSO")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Checkout")).toBeInTheDocument();
    // A new "Payments" epic was created alongside "Onboarding".
    const epicNames = screen
      .getAllByLabelText("Epic name")
      .map((i) => (i as HTMLInputElement).value);
    expect(epicNames).toEqual(["Onboarding", "Payments"]);
  });

  it("wires up task and epic dependencies by name, and reports unmatched ones", async () => {
    render(
      <ToastProvider>
        <ConfirmProvider>
          <AppStoreProvider initial={initialState()}>
            <DepsInner />
          </AppStoreProvider>
          <ToastHost />
        </ConfirmProvider>
      </ToastProvider>,
    );

    fireEvent.change(screen.getByLabelText("Pasted rows"), {
      target: {
        value: [
          // Task with an unmatched dependency name.
          "Payments\tCheckout UI\t4\tFrontend\tGhost",
          // Task depending on a sibling by name.
          "Payments\tRefunds\t2\tBackend\tCheckout UI",
          // Epic depending on the existing "Onboarding" epic.
          "Payments\tReporting\t3\tBackend\t\tOnboarding",
        ].join("\n"),
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() =>
      expect(screen.queryByLabelText("Pasted rows")).not.toBeInTheDocument(),
    );

    // "Refunds" depends on "Checkout UI"; "Ghost" is unmatched (1 dependency).
    expect(screen.getByTestId("probe")).toHaveTextContent(
      "task:Refunds->Checkout UI",
    );
    expect(screen.getByTestId("probe")).toHaveTextContent(
      "epic:Payments->Onboarding",
    );
    expect(
      screen.getByText(/1 dependency couldn't be matched by name/i),
    ).toBeInTheDocument();
  });
});

/** Like Inner, but also renders a probe that dumps resolved dependencies so
 *  tests can assert names resolved to the right ids. */
function DepsInner() {
  const { state } = useAppStore();
  const project = state.projects[0];
  const [open, setOpen] = useState(true);

  const idToTask = new Map<string, string>();
  const idToEpic = new Map<string, string>();
  for (const e of project.epics) {
    idToEpic.set(e.id, e.name);
    for (const t of e.tasks) idToTask.set(t.id, t.name);
  }
  const lines: string[] = [];
  for (const e of project.epics) {
    for (const dep of e.dependsOn ?? []) {
      lines.push(`epic:${e.name}->${idToEpic.get(dep) ?? dep}`);
    }
    for (const t of e.tasks) {
      for (const dep of t.dependsOn ?? []) {
        lines.push(`task:${t.name}->${idToTask.get(dep) ?? dep}`);
      }
    }
  }

  return (
    <>
      <div data-testid="probe">{lines.join(" | ")}</div>
      <PasteImportModal
        open={open}
        onClose={() => setOpen(false)}
        project={project}
      />
    </>
  );
}
