// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { parseImportedState, type AppState } from "@planner/core";
import {
  applyDeviceBackup,
  backupFilename,
  buildBackup,
  mergedJiraSettings,
  mergedTagAliases,
  parseBackup,
} from "./backup";
import {
  EMPTY_SETTINGS,
  readJiraSettings,
  writeJiraSettings,
  type JiraSettings,
} from "./jiraSettings";
import { readTagAliases, writeTagAliases } from "./tagAliases";

const jira: JiraSettings = {
  baseUrl: "https://acme.atlassian.net",
  email: "someone@example.com",
  apiToken: "secret-token",
  hoursPerDay: 6,
  allowWrites: true,
  orgId: "org-1",
};

const state: AppState = {
  projects: [
    {
      id: "p1",
      name: "Plan",
      startDate: "2026-01-01",
      epics: [],
      plan: null,
      planViewMode: "person",
    },
  ],
  teams: [{ id: "t1", name: "Team", members: [], offDays: {} }],
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

beforeEach(() => {
  localStorage.clear();
});

describe("buildBackup", () => {
  it("leaves the API token out unless asked", () => {
    const text = buildBackup(state, {
      jira,
      tagAliases: [],
      includeToken: false,
    });
    expect(text).not.toContain("secret-token");
    const { device } = parseBackup(text);
    expect(device?.jira).toEqual({
      baseUrl: jira.baseUrl,
      email: jira.email,
      hoursPerDay: 6,
      orgId: "org-1",
    });
  });

  it("includes the token when asked, but never allowWrites", () => {
    const text = buildBackup(state, {
      jira,
      tagAliases: [],
      includeToken: true,
    });
    const { device } = parseBackup(text);
    expect(device?.jira?.apiToken).toBe("secret-token");
    expect(text).not.toContain("allowWrites");
  });

  it("has no Jira section when Jira was never set up", () => {
    const text = buildBackup(state, {
      jira: EMPTY_SETTINGS,
      tagAliases: [],
      includeToken: true,
    });
    expect(parseBackup(text).device?.jira).toBeUndefined();
  });

  it("is still a plain Planner export the dashboard Import can read", () => {
    const text = buildBackup(state, {
      jira,
      tagAliases: [],
      includeToken: true,
    });
    const plain = parseImportedState(text);
    expect(plain.projects).toHaveLength(1);
    expect(plain.trackers).toHaveLength(1);
  });
});

describe("parseBackup", () => {
  it("round-trips projects, teams and trackers", () => {
    const text = buildBackup(state, {
      jira,
      tagAliases: [],
      includeToken: false,
    });
    expect(parseBackup(text).state).toEqual(state);
  });

  it("never lets device settings into the state", () => {
    const text = buildBackup(state, {
      jira,
      tagAliases: [],
      includeToken: true,
    });
    const parsed = parseBackup(text);
    expect(parsed.state).not.toHaveProperty("device");
    expect(JSON.stringify(parsed.state)).not.toContain("secret-token");
  });

  it("reads a plain export with no device section", () => {
    const parsed = parseBackup(JSON.stringify(state));
    expect(parsed.device).toBeNull();
    expect(parsed.state.trackers).toHaveLength(1);
  });

  it("rejects text that isn't JSON", () => {
    expect(() => parseBackup("nope")).toThrow(/valid JSON/);
  });

  it("drops malformed device fields instead of failing", () => {
    const parsed = parseBackup(
      JSON.stringify({ ...state, device: { jira: 42, tagAliases: "x" } }),
    );
    expect(parsed.device).toEqual({ version: 1 });
  });
});

describe("mergedJiraSettings", () => {
  it("takes the file's connection and keeps this device's write switch", () => {
    const here: JiraSettings = { ...EMPTY_SETTINGS, allowWrites: false };
    const next = mergedJiraSettings(here, {
      baseUrl: jira.baseUrl,
      email: jira.email,
      apiToken: "t",
      hoursPerDay: 6,
    });
    expect(next).toEqual({
      baseUrl: jira.baseUrl,
      email: jira.email,
      apiToken: "t",
      hoursPerDay: 6,
      allowWrites: false,
    });
  });

  it("keeps this device's token for the same account when the file has none", () => {
    const next = mergedJiraSettings(jira, {
      baseUrl: jira.baseUrl,
      email: jira.email,
      hoursPerDay: 7,
    });
    expect(next.apiToken).toBe("secret-token");
    expect(next.orgId).toBe("org-1");
  });

  it("does not reuse a token across accounts", () => {
    const next = mergedJiraSettings(jira, {
      baseUrl: jira.baseUrl,
      email: "other@example.com",
      hoursPerDay: 8,
    });
    expect(next.apiToken).toBe("");
    expect(next).not.toHaveProperty("orgId");
  });
});

describe("mergedTagAliases", () => {
  it("keeps local mappings and adds unseen tags", () => {
    expect(
      mergedTagAliases(
        [{ tag: "QA", specialization: "Testing" }],
        [
          { tag: "qa", specialization: "Other" },
          { tag: "BE", specialization: "Backend" },
        ],
      ),
    ).toEqual([
      { tag: "QA", specialization: "Testing" },
      { tag: "BE", specialization: "Backend" },
    ]);
  });
});

describe("applyDeviceBackup", () => {
  it("writes the Jira connection only when asked to", () => {
    const device = {
      version: 1,
      jira: { baseUrl: jira.baseUrl, email: jira.email, hoursPerDay: 6 },
    };
    applyDeviceBackup(device, { replaceJira: false });
    expect(readJiraSettings()).toEqual(EMPTY_SETTINGS);

    const result = applyDeviceBackup(device, { replaceJira: true });
    expect(result).toMatchObject({ jira: true, jiraNeedsToken: true });
    expect(readJiraSettings().email).toBe(jira.email);
  });

  it("reports a ready connection when the token came along", () => {
    writeJiraSettings(EMPTY_SETTINGS);
    const result = applyDeviceBackup(
      {
        version: 1,
        jira: {
          baseUrl: jira.baseUrl,
          email: jira.email,
          apiToken: "secret-token",
          hoursPerDay: 6,
        },
      },
      { replaceJira: true },
    );
    expect(result.jiraNeedsToken).toBe(false);
    expect(readJiraSettings().apiToken).toBe("secret-token");
  });

  it("adds tag mappings this device doesn't have", () => {
    writeTagAliases([{ tag: "QA", specialization: "Testing" }]);
    const result = applyDeviceBackup(
      {
        version: 1,
        tagAliases: [{ tag: "BE", specialization: "Backend" }],
      },
      { replaceJira: false },
    );
    expect(result.addedTagAliases).toBe(1);
    expect(readTagAliases()).toHaveLength(2);
  });
});

describe("backupFilename", () => {
  it("is dated", () => {
    expect(backupFilename(new Date(2026, 10, 9))).toBe(
      "planner-backup-2026-11-09.json",
    );
  });
});
