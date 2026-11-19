import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  EMPTY_SETTINGS,
  JIRA_SETTINGS_KEY,
  clearJiraSettings,
  isJiraConfigured,
  readJiraSettings,
  subscribeJiraSettings,
  writeJiraSettings,
  type JiraSettings,
} from "./jiraSettings";

const filled: JiraSettings = {
  baseUrl: "https://acme.atlassian.net",
  email: "someone@example.com",
  apiToken: "token-123",
  hoursPerDay: 6,
  allowWrites: true,
};

describe("jiraSettings", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("round-trips settings", () => {
    writeJiraSettings(filled);
    expect(readJiraSettings()).toEqual(filled);
  });

  it("returns empty settings when nothing is stored", () => {
    expect(readJiraSettings()).toEqual(EMPTY_SETTINGS);
  });

  it("survives corrupt storage without throwing", () => {
    localStorage.setItem(JIRA_SETTINGS_KEY, "{not json");
    expect(readJiraSettings()).toEqual(EMPTY_SETTINGS);
    localStorage.setItem(JIRA_SETTINGS_KEY, "[1,2,3]");
    expect(readJiraSettings()).toEqual(EMPTY_SETTINGS);
  });

  it("falls back to 8 hours a day for a missing or absurd value", () => {
    localStorage.setItem(
      JIRA_SETTINGS_KEY,
      JSON.stringify({ ...filled, hoursPerDay: -4 }),
    );
    expect(readJiraSettings().hoursPerDay).toBe(8);
  });

  it("treats anything but true as writes-disabled", () => {
    localStorage.setItem(
      JIRA_SETTINGS_KEY,
      JSON.stringify({ ...filled, allowWrites: "yes" }),
    );
    expect(readJiraSettings().allowWrites).toBe(false);
  });

  it("clears the key completely", () => {
    writeJiraSettings(filled);
    clearJiraSettings();
    expect(localStorage.getItem(JIRA_SETTINGS_KEY)).toBeNull();
    expect(readJiraSettings()).toEqual(EMPTY_SETTINGS);
  });

  it("needs a url, an email and a token before it is usable", () => {
    expect(isJiraConfigured(EMPTY_SETTINGS)).toBe(false);
    expect(isJiraConfigured({ ...filled, apiToken: "  " })).toBe(false);
    expect(isJiraConfigured(filled)).toBe(true);
  });

  it("notifies subscribers on write and clear", () => {
    const seen = vi.fn();
    const stop = subscribeJiraSettings(seen);
    writeJiraSettings(filled);
    clearJiraSettings();
    expect(seen).toHaveBeenCalledTimes(2);
    stop();
    writeJiraSettings(filled);
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it("keeps reads working when localStorage itself throws", () => {
    const spy = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });
    expect(readJiraSettings()).toEqual(EMPTY_SETTINGS);
    spy.mockRestore();
  });
});
