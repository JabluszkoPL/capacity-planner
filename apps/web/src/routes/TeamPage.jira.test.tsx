// @vitest-environment jsdom
/**
 * "Add from Jira" on the Team page, end to end: a scripted Jira answers the
 * organization lookup, the Teams directory and the user lookup, and the
 * picked team lands on the page next to the hand-made one, editable like it.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AppState } from "@planner/core";
import type { JiraRequest } from "@planner/jira";
import { AppStoreProvider } from "@planner/client-runtime";
import { ConfirmProvider } from "../components/ui/ConfirmDialog";
import { ToastProvider, ToastHost } from "../components/ui/Toast";
import { readJiraSettings, writeJiraSettings } from "../lib/jiraSettings";
import { TeamPage } from "./TeamPage";

const calls: JiraRequest[] = [];
let tenantAllowed = true;
/** False = Atlassian refuses every roster read, as it does for some accounts. */
let rosterAllowed = true;

vi.mock("../lib/jiraTransport", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/jiraTransport")>();
  const members: Record<string, string[]> = {
    "t-stars": ["ada", "bo"],
    "t-moons": ["cy"],
  };
  const names: Record<string, string> = {
    ada: "Ada Lovelace",
    bo: "Bo Diddley",
    cy: "Cy Twombly",
  };
  return {
    ...real,
    createJiraTransport: () => ({
      kind: "proxy",
      description: "via a test",
      canWrite: false,
      request(req: JiraRequest) {
        calls.push(req);
        const ok = (body: unknown) => Promise.resolve({ status: 200, body });
        const op = (req.body as { operationName?: string } | undefined)
          ?.operationName;
        if (req.path === "/gateway/api/graphql" && op !== "PlannerTenant") {
          return ok({
            errors: [
              {
                message: "The underlying service teamsV2 status code is: 403",
                extensions: { statusCode: 403 },
              },
            ],
          });
        }
        if (req.path === "/rest/api/3/field") {
          return ok([{ id: "customfield_10001", name: "Team", custom: true }]);
        }
        if (req.path.startsWith("/rest/api/3/search/jql")) {
          const who = (accountId: string) => ({
            fields: {
              assignee: { accountId, displayName: names[accountId] },
            },
          });
          return ok({ issues: [who("ada"), who("ada"), who("cy")] });
        }
        if (req.path === "/gateway/api/graphql") {
          return tenantAllowed
            ? ok({ data: { tenantContexts: [{ orgId: "org-1" }] } })
            : Promise.resolve({ status: 403, body: null });
        }
        const team = /teams\/([^/]+)\/members/.exec(req.path);
        if (team && !rosterAllowed) {
          return Promise.resolve({
            status: 403,
            body: { message: "Forbidden" },
          });
        }
        if (team) {
          return ok({
            results: (members[team[1]] ?? []).map((accountId) => ({
              accountId,
            })),
            pageInfo: { hasNextPage: false },
          });
        }
        if (req.path.includes("/teams?")) {
          return ok({
            entities: [
              { teamId: "t-stars", displayName: "Stars", state: "ACTIVE" },
              { teamId: "t-moons", displayName: "Moons", state: "ACTIVE" },
            ],
          });
        }
        if (req.path.startsWith("/rest/api/3/user/bulk")) {
          const ids = [...req.path.matchAll(/accountId=([^&]+)/g)].map(
            (m) => m[1],
          );
          return ok({
            values: ids.map((accountId) => ({
              accountId,
              displayName: names[accountId],
              active: true,
            })),
          });
        }
        return Promise.resolve({ status: 404, body: null });
      },
    }),
  };
});

const initial: AppState = {
  projects: [],
  teams: [
    {
      id: "manual",
      name: "Hand made",
      members: [{ id: "m1", name: "Eve", specialization: "Backend" }],
      offDays: {},
    },
  ],
};

beforeEach(() => {
  calls.length = 0;
  tenantAllowed = true;
  rosterAllowed = true;
  localStorage.clear();
  // Through the writer, so the settings hook drops what it cached.
  writeJiraSettings({
    baseUrl: "https://acme.atlassian.net",
    email: "dana@example.com",
    apiToken: "token",
    hoursPerDay: 8,
    allowWrites: false,
  });
});

function renderPage() {
  return render(
    <ToastProvider>
      <ConfirmProvider>
        <AppStoreProvider initial={initial}>
          <TeamPage />
        </AppStoreProvider>
      </ConfirmProvider>
      <ToastHost />
    </ToastProvider>,
  );
}

const teamNames = () =>
  screen
    .getAllByLabelText("Team name")
    .map((el) => (el as HTMLInputElement).value);

describe("Team page — add from Jira", () => {
  it("lists the Teams directory and adds a team with its members", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: "Add from Jira…" }));
    const dialog = await screen.findByRole("dialog");
    // Loaded straight away, with the organization found automatically.
    const stars = await within(dialog).findByRole("checkbox", {
      name: "Stars",
    });
    expect(within(dialog).getByText("Moons")).toBeTruthy();

    await user.click(stars);
    const spec = await within(dialog).findByLabelText(
      "Specialization of Bo Diddley",
    );
    await user.type(spec, "QA");
    await user.click(
      within(dialog).getByRole("button", { name: "Add 1 team" }),
    );

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(teamNames()).toEqual(["Hand made", "Stars"]);
    expect(screen.getByText("From Jira")).toBeTruthy();
    expect(screen.getAllByText("Ada Lovelace").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Bo Diddley").length).toBeGreaterThan(0);
    expect(
      await screen.findByText(/1 team added from Jira — 2 people/),
    ).toBeTruthy();
    expect(readJiraSettings().orgId).toBe("org-1");
  });

  it("asks for the organization ID when it cannot be found", async () => {
    tenantAllowed = false;
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: "Add from Jira…" }));
    const dialog = await screen.findByRole("dialog");
    const org = await within(dialog).findByLabelText(
      "Atlassian organization ID",
    );
    await user.type(org, "https://admin.atlassian.com/o/org-typed/overview");
    await user.click(
      within(dialog).getByRole("button", { name: "Load teams" }),
    );

    expect(
      await within(dialog).findByRole("checkbox", { name: "Stars" }),
    ).toBeTruthy();
    expect(calls.some((c) => c.path.includes("/org/org-typed/teams"))).toBe(
      true,
    );
    expect(readJiraSettings().orgId).toBe("org-typed");
  });

  it("offers an update, not a duplicate, for a team imported before", async () => {
    const user = userEvent.setup();
    renderPage();
    const openStars = async () => {
      await user.click(screen.getByRole("button", { name: "Add from Jira…" }));
      const dialog = await screen.findByRole("dialog");
      await user.click(
        await within(dialog).findByRole("checkbox", { name: "Stars" }),
      );
      await within(dialog).findByText("Ada Lovelace");
      return dialog;
    };

    let dialog = await openStars();
    await user.click(
      within(dialog).getByRole("checkbox", { name: "Bo Diddley" }),
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Add 1 team" }),
    );

    dialog = await openStars();
    expect(within(dialog).getByText("Updates “Stars”")).toBeTruthy();
    expect(within(dialog).getByText(/already in Stars/)).toBeTruthy();
    await user.click(
      within(dialog).getByRole("button", { name: "Add 1 team" }),
    );

    expect(teamNames()).toEqual(["Hand made", "Stars"]);
    expect(screen.getAllByText("Bo Diddley").length).toBeGreaterThan(0);
  });

  it("offers the people on the team's issues when the roster is refused", async () => {
    rosterAllowed = false;
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: "Add from Jira…" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(
      await within(dialog).findByRole("checkbox", { name: "Stars" }),
    );
    const note = await within(dialog).findByRole("note");
    expect(note.textContent).toMatch(/Not the team's roster/);
    expect(note.textContent).toMatch(/Forbidden/);
    expect(
      within(dialog).getByRole("columnheader", { name: "Issues" }),
    ).toBeTruthy();
    expect(
      within(dialog).getByRole("checkbox", { name: "Ada Lovelace" }),
    ).toBeTruthy();

    await user.click(
      within(dialog).getByRole("checkbox", { name: "Cy Twombly" }),
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Add 1 team" }),
    );
    expect(teamNames()).toEqual(["Hand made", "Stars"]);
    expect(screen.getAllByText("Ada Lovelace").length).toBeGreaterThan(0);
    expect(screen.queryByText("Cy Twombly")).toBeNull();
  });
});
