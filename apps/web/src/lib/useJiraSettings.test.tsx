import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { useJiraSettings } from "./useJiraSettings";
import { clearJiraSettings, writeJiraSettings } from "./jiraSettings";

function Probe() {
  const settings = useJiraSettings();
  return <span data-testid="email">{settings.email || "(none)"}</span>;
}

describe("useJiraSettings", () => {
  beforeEach(() => {
    localStorage.clear();
    // Put the module cache back in step with the cleared storage.
    clearJiraSettings();
  });

  it("reads the stored settings", () => {
    writeJiraSettings({
      baseUrl: "https://acme.atlassian.net",
      email: "sam@example.com",
      apiToken: "t",
      hoursPerDay: 8,
      allowWrites: false,
    });
    render(<Probe />);
    expect(screen.getByTestId("email")).toHaveTextContent("sam@example.com");
  });

  it("re-renders when the settings change while mounted", () => {
    render(<Probe />);
    expect(screen.getByTestId("email")).toHaveTextContent("(none)");
    act(() => {
      writeJiraSettings({
        baseUrl: "https://acme.atlassian.net",
        email: "later@example.com",
        apiToken: "t",
        hoursPerDay: 8,
        allowWrites: false,
      });
    });
    expect(screen.getByTestId("email")).toHaveTextContent("later@example.com");
  });

  it("sees settings written while nothing was mounted", () => {
    // Regression: the cache used to be invalidated only from inside a
    // component's own subscription, so a write with no subscriber left every
    // later reader looking at the settings as they were before it.
    render(<Probe />).unmount();
    writeJiraSettings({
      baseUrl: "https://acme.atlassian.net",
      email: "written-while-unmounted@example.com",
      apiToken: "t",
      hoursPerDay: 8,
      allowWrites: false,
    });
    render(<Probe />);
    expect(screen.getByTestId("email")).toHaveTextContent(
      "written-while-unmounted@example.com",
    );
  });
});
