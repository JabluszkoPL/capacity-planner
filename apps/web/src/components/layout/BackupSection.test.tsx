import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AppState } from "@planner/core";
import { AppStoreProvider, useAppStore } from "@planner/client-runtime";
import { ToastHost, ToastProvider } from "../ui/Toast";
import { BackupSection } from "./BackupSection";
import { buildBackup } from "../../lib/backup";
import {
  EMPTY_SETTINGS,
  readJiraSettings,
  writeJiraSettings,
  type JiraSettings,
} from "../../lib/jiraSettings";

const jira: JiraSettings = {
  baseUrl: "https://acme.atlassian.net",
  email: "someone@example.com",
  apiToken: "secret-token",
  hoursPerDay: 8,
  allowWrites: false,
};

const browserState: AppState = {
  projects: [
    {
      id: "p1",
      name: "Q1 plan",
      startDate: "2026-01-01",
      epics: [],
      plan: null,
      planViewMode: "person",
    },
  ],
  teams: [{ id: "t1", name: "Core", members: [], offDays: {} }],
  trackers: [
    {
      id: "tr1",
      name: "Initiative",
      initiativeUrl: "https://acme.atlassian.net/browse/ACME-1",
      initiativeKey: "ACME-1",
      baseUrl: "https://acme.atlassian.net",
      projectId: "p1",
    },
  ],
};

function Counts() {
  const { state } = useAppStore();
  return (
    <p data-testid="counts">
      {state.projects.length}/{state.teams.length}/{state.trackers?.length ?? 0}
    </p>
  );
}

function renderSection(initial: AppState = { projects: [], teams: [] }) {
  return render(
    <ToastProvider>
      <AppStoreProvider initial={initial}>
        <BackupSection />
        <Counts />
        <ToastHost />
      </AppStoreProvider>
    </ToastProvider>,
  );
}

function fileInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("file input not rendered");
  return input;
}

function backupFile(includeToken: boolean) {
  const text = buildBackup(browserState, {
    jira,
    tagAliases: [],
    includeToken,
  });
  return new File([text], "planner-backup.json", { type: "application/json" });
}

beforeEach(() => {
  localStorage.clear();
});

describe("BackupSection", () => {
  it("can't include a token when Jira isn't connected", () => {
    renderSection();
    expect(
      screen.getByRole("checkbox", { name: /include the jira api token/i }),
    ).toBeDisabled();
  });

  it("warns before exporting the token", async () => {
    writeJiraSettings(jira);
    renderSection();
    await userEvent.click(
      screen.getByRole("checkbox", { name: /include the jira api token/i }),
    );
    expect(
      screen.getByText(/can use jira as someone@example.com/i),
    ).toBeVisible();
  });

  it("previews a backup and changes nothing until confirmed", async () => {
    renderSection();
    await userEvent.upload(fileInput(), backupFile(true));

    const preview = await screen.findByRole("group", {
      name: /import planner-backup.json/i,
    });
    expect(preview).toHaveFocus();
    expect(preview).toHaveTextContent(
      "1 project, 1 team and 1 tracker will be added",
    );
    expect(screen.getByTestId("counts")).toHaveTextContent("0/0/0");
    expect(readJiraSettings()).toEqual(EMPTY_SETTINGS);
  });

  it("imports projects, teams, trackers and the Jira connection", async () => {
    renderSection();
    await userEvent.upload(fileInput(), backupFile(true));
    const useJira = await screen.findByRole("checkbox", {
      name: /use its jira connection/i,
    });
    expect(useJira).toBeChecked();

    await userEvent.click(screen.getByRole("button", { name: "Import" }));

    expect(screen.getByTestId("counts")).toHaveTextContent("1/1/1");
    expect(readJiraSettings()).toMatchObject({
      baseUrl: jira.baseUrl,
      email: jira.email,
      apiToken: "secret-token",
    });
    expect(await screen.findByText(/Jira connected/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Import backup…" }),
    ).toHaveFocus();
  });

  it("says when the token still has to be typed in", async () => {
    renderSection();
    await userEvent.upload(fileInput(), backupFile(false));
    await userEvent.click(
      await screen.findByRole("button", { name: "Import" }),
    );
    expect(
      await screen.findByText(/add your API token in Jira settings/),
    ).toBeInTheDocument();
    expect(readJiraSettings().apiToken).toBe("");
  });

  it("does not replace a different Jira account unless asked", async () => {
    const mine = { ...jira, email: "me@example.com", apiToken: "mine" };
    writeJiraSettings(mine);
    renderSection();
    await userEvent.upload(fileInput(), backupFile(true));
    const useJira = await screen.findByRole("checkbox", {
      name: /use its jira connection.*replacing/i,
    });
    expect(useJira).not.toBeChecked();

    await userEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(readJiraSettings()).toEqual(mine);
  });

  it("cancel leaves everything as it was", async () => {
    renderSection();
    await userEvent.upload(fileInput(), backupFile(true));
    await userEvent.click(
      await screen.findByRole("button", { name: "Cancel" }),
    );
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
    expect(screen.getByTestId("counts")).toHaveTextContent("0/0/0");
    expect(readJiraSettings()).toEqual(EMPTY_SETTINGS);
  });

  it("reports a file that isn't a Planner export", async () => {
    renderSection();
    await userEvent.upload(
      fileInput(),
      new File(["{}"], "x.json", { type: "application/json" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        /doesn't look like a Planner export/,
      ),
    );
  });
});
