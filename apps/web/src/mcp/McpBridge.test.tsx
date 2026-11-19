import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { AppStoreProvider, useAppStore } from "@planner/client-runtime";
import type { AppState } from "@planner/core";
import { ToastProvider, ToastHost } from "../components/ui/Toast";
import { McpBridge } from "./McpBridge";
import type { McpCallReply, PlannerMcpBridge } from "../lib/hostBridge";
import { JIRA_SETTINGS_KEY } from "../lib/jiraSettings";

type Handler = (
  name: string,
  args: unknown,
  allowWrites: boolean,
) => Promise<McpCallReply>;

const STATE: AppState = {
  teams: [
    {
      id: "team-1",
      name: "Core",
      members: [{ id: "m-1", name: "Alice Kim", specialization: "Frontend" }],
      offDays: {},
    },
  ],
  projects: [
    {
      id: "p-1",
      name: "Apollo",
      startDate: "2026-01-05",
      planViewMode: "person",
      plan: null,
      epics: [
        {
          id: "e-1",
          name: "Login",
          tasks: [
            {
              id: "t-1",
              name: "UI",
              estimateDays: 2,
              specialization: "Frontend",
              excluded: false,
            },
          ],
        },
      ],
    },
  ],
};

function installHost() {
  let handler: Handler | null = null;
  let served = 0;
  const mcp: PlannerMcpBridge = {
    state: async () => {
      throw new Error("unused");
    },
    update: async () => {
      throw new Error("unused");
    },
    regenerateToken: async () => {
      throw new Error("unused");
    },
    onChange: () => () => {},
    serve: (h) => {
      handler = h;
      served++;
      return () => {
        handler = null;
      };
    },
  };
  window.planner = {
    db: {} as never,
    syncUrl: null,
    platform: "darwin",
    version: "38",
    mcp,
  };
  return {
    call: (name: string, args: unknown = {}, allowWrites = false) => {
      if (!handler) throw new Error("the bridge is not serving");
      return handler(name, args, allowWrites);
    },
    served: () => served,
  };
}

/** Shows what the store and router hold, for assertions. */
function Probe() {
  const { state } = useAppStore();
  const location = useLocation();
  const alice = state.teams[0]?.offDays["m-1"] ?? [];
  return (
    <div>
      <p data-testid="path">{location.pathname}</p>
      <p data-testid="off">{alice.join(",")}</p>
      <p data-testid="plan">
        {state.projects[0]?.plan
          ? `${state.projects[0].plan.assignments.length} assignments`
          : "no plan"}
      </p>
    </div>
  );
}

function renderApp() {
  return render(
    <ToastProvider>
      <AppStoreProvider initial={STATE}>
        <MemoryRouter initialEntries={["/"]}>
          <McpBridge />
          <Routes>
            <Route path="*" element={<Probe />} />
          </Routes>
        </MemoryRouter>
        <ToastHost />
      </AppStoreProvider>
    </ToastProvider>,
  );
}

// Calls arrive from the main process, outside React, and the bridge waits for
// React to commit each change before replying. act() would hold that commit
// back until the call returned, so these tests let React schedule as it does
// in the app.
const ACT = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
let actBefore: boolean | undefined;
beforeAll(() => {
  actBefore = ACT.IS_REACT_ACT_ENVIRONMENT;
  ACT.IS_REACT_ACT_ENVIRONMENT = false;
});
afterAll(() => {
  ACT.IS_REACT_ACT_ENVIRONMENT = actBefore;
});

afterEach(() => {
  delete window.planner;
  localStorage.clear();
});

describe("McpBridge", () => {
  it("does nothing in a browser tab", () => {
    renderApp();
    expect(screen.getByTestId("path")).toHaveTextContent("/");
  });

  it("answers reads from the live store", async () => {
    const host = installHost();
    renderApp();
    const reply = await host.call("list_projects");
    expect(reply).toMatchObject({
      result: { projects: [expect.objectContaining({ name: "Apollo" })] },
    });
  });

  it("applies writes through the store, then replies with the new state", async () => {
    const host = installHost();
    renderApp();
    const started = Date.now();
    const reply = await host.call(
      "set_member_off_days",
      { member: "Alice Kim", add: ["2026-01-08..2026-01-09"] },
      true,
    );
    // Replied once the store took the change, not after the fallback wait.
    expect(Date.now() - started).toBeLessThan(1000);
    expect(reply).toMatchObject({
      result: { offDays: ["2026-01-08", "2026-01-09"] },
    });
    expect(screen.getByTestId("off")).toHaveTextContent(
      "2026-01-08,2026-01-09",
    );
    expect(
      await screen.findByText(/AI assistant: Updated days off for Alice Kim/),
    ).toBeInTheDocument();

    // The next call reads what the last one wrote.
    await host.call("run_plan", { project: "Apollo" }, true);
    expect(screen.getByTestId("plan")).toHaveTextContent("1 assignments");
    await waitFor(() =>
      expect(screen.getByTestId("path")).toHaveTextContent("/project/p-1"),
    );
  });

  it("refuses writes when the main process says changes are off", async () => {
    const host = installHost();
    renderApp();
    const reply = await host.call(
      "set_member_off_days",
      { member: "Alice Kim", add: ["2026-01-08"] },
      false,
    );
    expect(reply).toEqual({
      error: expect.stringContaining("Changes are turned off"),
    });
    expect(screen.getByTestId("off")).toHaveTextContent("");
  });

  it("navigates the window for view tools", async () => {
    const host = installHost();
    renderApp();
    await host.call("open_page", { page: "tracking" });
    await waitFor(() =>
      expect(screen.getByTestId("path")).toHaveTextContent("/tracking"),
    );
    expect(await host.call("get_current_view")).toMatchObject({
      result: { page: "tracking" },
    });
  });

  it("passes a tool's own error back as text", async () => {
    const host = installHost();
    renderApp();
    expect(await host.call("get_project", { project: "Zeus" })).toEqual({
      error: 'No project matches "Zeus". Known: "Apollo".',
    });
  });

  it("never lets Jira credentials into a reply", async () => {
    localStorage.setItem(
      JIRA_SETTINGS_KEY,
      JSON.stringify({
        baseUrl: "https://acme.atlassian.net",
        email: "me@example.com",
        apiToken: "SECRET-JIRA-TOKEN",
      }),
    );
    const host = installHost();
    renderApp();
    const replies = await Promise.all(
      ["list_projects", "list_teams", "list_trackers", "get_current_view"].map(
        (name) => host.call(name),
      ),
    );
    const text = JSON.stringify(replies);
    expect(text).not.toContain("SECRET-JIRA-TOKEN");
    expect(text).not.toContain("me@example.com");
    expect(host.served()).toBeGreaterThan(0);
  });
});
