import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ConfirmProvider } from "../ui/ConfirmDialog";
import { ToastProvider, ToastHost } from "../ui/Toast";
import { JiraSettingsPanel } from "./JiraSettingsPanel";
import {
  readJiraSettings,
  writeJiraSettings,
  EMPTY_SETTINGS,
} from "../../lib/jiraSettings";
import type { AppJiraTransport } from "../../lib/jiraTransport";

function fakeTransport(request: AppJiraTransport["request"]): AppJiraTransport {
  return {
    kind: "proxy",
    description: "via the test",
    canWrite: false,
    request,
  };
}

function renderPanel(request: AppJiraTransport["request"]) {
  return render(
    <ToastProvider>
      <ConfirmProvider>
        <JiraSettingsPanel
          open
          onClose={() => {}}
          settings={EMPTY_SETTINGS}
          transport={fakeTransport(request)}
        />
        <ToastHost />
      </ConfirmProvider>
    </ToastProvider>,
  );
}

function fillConnectionFields() {
  fireEvent.change(screen.getByLabelText("Jira URL"), {
    target: { value: "https://acme.atlassian.net" },
  });
  fireEvent.change(screen.getByLabelText("Atlassian email"), {
    target: { value: "dev@acme.com" },
  });
  fireEvent.change(screen.getByLabelText("API token"), {
    target: { value: "secret-token" },
  });
}

describe("JiraSettingsPanel", () => {
  beforeEach(() => localStorage.clear());

  it("persists credentials as soon as Test connection succeeds", async () => {
    const request = vi.fn().mockImplementation(({ path }: { path: string }) =>
      Promise.resolve(
        path === "/rest/api/3/myself"
          ? {
              status: 200,
              body: { accountId: "user-1", displayName: "Alex" },
            }
          : { status: 200, body: [] },
      ),
    );
    renderPanel(request);

    fillConnectionFields();
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));

    await waitFor(() =>
      expect(
        screen.getByText("Connected as Alex — data access verified and saved"),
      ).toBeInTheDocument(),
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ path: "/rest/api/3/field" }),
    );
    expect(readJiraSettings()).toMatchObject({
      baseUrl: "https://acme.atlassian.net",
      email: "dev@acme.com",
      apiToken: "secret-token",
    });
  });

  it("does not persist credentials when the test is rejected", async () => {
    const request = vi.fn().mockResolvedValue({ status: 401, body: null });
    renderPanel(request);

    fillConnectionFields();
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));

    await waitFor(() =>
      expect(
        screen.getByText("Jira rejected that email and token"),
      ).toBeInTheDocument(),
    );
    expect(readJiraSettings().apiToken).toBe("");
  });

  it("does not accept a non-Jira HTTP 200 response", async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ status: 200, body: "<html>Planner</html>" });
    renderPanel(request);

    fillConnectionFields();
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));

    await waitFor(() =>
      expect(
        screen.getByText("The Jira route returned an unexpected response"),
      ).toBeInTheDocument(),
    );
    expect(request).toHaveBeenCalledTimes(1);
    expect(readJiraSettings().apiToken).toBe("");
  });

  it("does not save credentials when Jira data access fails", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        body: { accountId: "user-1", displayName: "Alex" },
      })
      .mockResolvedValueOnce({ status: 403, body: null });
    renderPanel(request);

    fillConnectionFields();
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));

    await waitFor(() =>
      expect(
        screen.getByText("Jira accepted the connection but denied data access"),
      ).toBeInTheDocument(),
    );
    expect(readJiraSettings().apiToken).toBe("");
  });

  it("asks for confirmation before clearing stored credentials", async () => {
    const settings = {
      baseUrl: "https://acme.atlassian.net",
      email: "dev@acme.com",
      apiToken: "stored-token",
      hoursPerDay: 8,
      allowWrites: false,
    };
    writeJiraSettings(settings);
    render(
      <ToastProvider>
        <ConfirmProvider>
          <JiraSettingsPanel
            open
            onClose={() => {}}
            settings={settings}
            transport={fakeTransport(vi.fn())}
          />
          <ToastHost />
        </ConfirmProvider>
      </ToastProvider>,
    );

    // Opening the confirmation must not clear anything by itself. Both the
    // panel and the dialog have their own "Cancel"/"Clear credentials"
    // buttons; the dialog's render last.
    fireEvent.click(screen.getByRole("button", { name: "Clear credentials" }));
    expect(screen.getByText("Clear Jira credentials")).toBeInTheDocument();
    const cancelButtons = screen.getAllByRole("button", { name: "Cancel" });
    fireEvent.click(cancelButtons[cancelButtons.length - 1]);
    expect(readJiraSettings().apiToken).toBe("stored-token");

    // Confirming does clear it. Both the panel's own button and the dialog's
    // confirm button are labelled "Clear credentials"; the dialog's is the
    // one that renders last.
    fireEvent.click(screen.getByRole("button", { name: "Clear credentials" }));
    const buttons = screen.getAllByRole("button", {
      name: "Clear credentials",
    });
    fireEvent.click(buttons[buttons.length - 1]);
    await waitFor(() => expect(readJiraSettings().apiToken).toBe(""));
  });
});
