import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { JiraIssue, JiraSnapshot, SprintDraftItem } from "@planner/core";
import type { JiraRequest, JiraResponse, WriteSpan } from "@planner/jira";
import type { SprintItemApplied } from "@planner/client-runtime";
import { ToastProvider } from "../ui/Toast";
import type { JiraSettings } from "../../lib/jiraSettings";
import type { AppJiraTransport } from "../../lib/jiraTransport";
import { WritebackModal } from "./WritebackModal";

const BASE_URL = "https://acme.atlassian.net";

const SETTINGS: JiraSettings = {
  baseUrl: BASE_URL,
  email: "dana@example.com",
  apiToken: "super-secret-token",
  hoursPerDay: 8,
  allowWrites: true,
};

function child(
  key: string,
  summary: string,
  dates?: { startDate: string; dueDate: string },
): JiraIssue {
  return {
    key,
    summary,
    issueType: "Story",
    status: "To Do",
    statusCategory: "new",
    updated: "2026-09-14T10:00:00.000Z",
    ...dates,
  };
}

/** One epic with three children: dated, undated, and already correct. */
const SNAPSHOT: JiraSnapshot = {
  fetchedAt: "2026-09-15T08:00:00.000Z",
  fieldIds: { startDate: "customfield_10015" },
  initiative: child("ACME-1", "Checkout modernisation"),
  epics: [
    {
      ...child("ACME-10", "Payment provider swap"),
      children: [
        child("ACME-101", "Refund flow against the new provider", {
          startDate: "2026-07-13",
          dueDate: "2026-07-17",
        }),
        child("ACME-102", "3-D Secure challenge loops on retry"),
        child("ACME-103", "Import legacy address rows", {
          startDate: "2026-09-29",
          dueDate: "2026-09-30",
        }),
      ],
      totals: {
        originalSec: 0,
        spentSec: 0,
        remainingSec: 0,
        done: 0,
        all: 3,
      },
    },
  ],
};

function item(issueKey: string): SprintDraftItem {
  return { issueKey, estimateDays: 2, start: "2026-09-22" };
}

const ITEMS: SprintDraftItem[] = [
  item("ACME-101"),
  item("ACME-102"),
  item("ACME-103"),
];

/** ACME-103 already holds these dates in Jira, so it is not a change. */
const SPANS = new Map<string, WriteSpan>([
  ["ACME-101", { start: "2026-09-22", end: "2026-09-24" }],
  ["ACME-102", { start: "2026-09-25", end: "2026-09-28" }],
  ["ACME-103", { start: "2026-09-29", end: "2026-09-30" }],
]);

const noContent: JiraResponse = { status: 204, body: null };

/** A transport that answers from a script and records what it was asked. */
function stubTransport(script: JiraResponse[], canWrite = true) {
  const calls: JiraRequest[] = [];
  const queue = [...script];
  const transport: AppJiraTransport = {
    kind: "proxy",
    description: "via the test",
    canWrite,
    request(req) {
      calls.push(req);
      const next = queue.shift();
      return next
        ? Promise.resolve(next)
        : Promise.reject(new Error(`unscripted ${req.method} ${req.path}`));
    },
  };
  return { transport, calls };
}

function renderModal(
  transport: AppJiraTransport,
  onApplied: (applied: SprintItemApplied[]) => void = () => {},
  items: SprintDraftItem[] = ITEMS,
) {
  return render(
    <ToastProvider>
      <WritebackModal
        open
        onClose={() => {}}
        items={items}
        spans={SPANS}
        snapshot={SNAPSHOT}
        baseUrl={BASE_URL}
        settings={SETTINGS}
        transport={transport}
        onApplied={onApplied}
      />
    </ToastProvider>,
  );
}

function applyButton(): HTMLElement {
  return screen.getByRole("button", { name: "Apply to Jira" });
}

describe("WritebackModal", () => {
  it("previews both sides of every date it would change", () => {
    renderModal(stubTransport([]).transport);
    // ACME-103 already has the drafted dates, so it is not offered.
    expect(
      screen.getByText("2 issues will get new dates in Jira."),
    ).toBeInTheDocument();
    expect(screen.getByText("ACME-101")).toBeInTheDocument();
    expect(screen.queryByText("ACME-103")).not.toBeInTheDocument();
    expect(screen.getByText("2026-07-13")).toBeInTheDocument();
    expect(
      screen.getByText("→ 2026-09-22", { exact: false }),
    ).toBeInTheDocument();
    // An issue with no dates in Jira yet still reads as a row, not a blank.
    expect(screen.getAllByText("—")).toHaveLength(2);
  });

  it("keeps Apply disabled until the changes are reviewed", () => {
    renderModal(stubTransport([]).transport);
    expect(applyButton()).toBeDisabled();

    fireEvent.click(screen.getByLabelText("I reviewed these changes"));
    expect(applyButton()).toBeEnabled();
  });

  it("writes the dates and replaces the table with the outcomes", async () => {
    const { transport, calls } = stubTransport([
      noContent,
      {
        status: 403,
        body: { errorMessages: ["You do not have permission to edit issues."] },
      },
    ]);
    renderModal(transport);

    fireEvent.click(screen.getByLabelText("I reviewed these changes"));
    fireEvent.click(applyButton());

    await waitFor(() =>
      expect(screen.getByText("Updated")).toBeInTheDocument(),
    );
    expect(screen.getByText(/Failed — .*403/)).toBeInTheDocument();
    // Both outcomes are announced, and the preview is gone.
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();

    expect(calls.map((c) => c.path)).toEqual([
      "/rest/api/3/issue/ACME-101",
      "/rest/api/3/issue/ACME-102",
    ]);
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].baseUrl).toBe(BASE_URL);
    expect(calls[0].body).toEqual({
      fields: { customfield_10015: "2026-09-22", duedate: "2026-09-24" },
    });
  });

  it("hands onApplied only the issues Jira accepted", async () => {
    const onApplied = vi.fn();
    const { transport } = stubTransport([
      noContent,
      { status: 403, body: null },
    ]);
    renderModal(transport, onApplied);

    fireEvent.click(screen.getByLabelText("I reviewed these changes"));
    fireEvent.click(applyButton());

    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
    const applied = onApplied.mock.calls[0][0] as SprintItemApplied[];
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({
      issueKey: "ACME-101",
      startDate: "2026-09-22",
      dueDate: "2026-09-24",
    });
    expect(typeof applied[0].at).toBe("string");
  });

  it("sends nothing when the transport refuses writes", async () => {
    const onApplied = vi.fn();
    const { transport, calls } = stubTransport([noContent], false);
    renderModal(transport, onApplied);

    fireEvent.click(screen.getByLabelText("I reviewed these changes"));
    fireEvent.click(applyButton());

    await waitFor(() => expect(applyButton()).toBeEnabled());
    expect(calls).toHaveLength(0);
    expect(onApplied).not.toHaveBeenCalled();
    // The preview stays put: nothing happened, so there is nothing to report.
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  it("says so rather than offering a write when nothing changed", () => {
    renderModal(stubTransport([]).transport, () => {}, [item("ACME-103")]);
    expect(
      screen.getByText("Nothing to write — Jira already has these dates."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("I reviewed these changes"));
    expect(applyButton()).toBeDisabled();
  });
});
