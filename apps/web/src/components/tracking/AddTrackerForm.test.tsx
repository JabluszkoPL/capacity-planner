import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AddTrackerForm } from "./AddTrackerForm";

const SITE = "https://acme.atlassian.net";

function setup(fallbackBaseUrl = "") {
  const onAdd = vi.fn();
  render(<AddTrackerForm fallbackBaseUrl={fallbackBaseUrl} onAdd={onAdd} />);
  const input = screen.getByLabelText("Initiative link or key");
  const submit = screen.getByRole("button", { name: "+ Add tracker" });
  const paste = (value: string) => {
    fireEvent.change(input, { target: { value } });
    fireEvent.click(submit);
  };
  return { onAdd, input, submit, paste };
}

describe("AddTrackerForm", () => {
  it("stays disabled until something is pasted", () => {
    const { input, submit } = setup();
    expect(submit).toBeDisabled();
    fireEvent.change(input, { target: { value: "  " } });
    expect(submit).toBeDisabled();
    fireEvent.change(input, { target: { value: `${SITE}/browse/ACME-1` } });
    expect(submit).toBeEnabled();
  });

  it.each([
    [`${SITE}/browse/ACME-12345`, "ACME-12345"],
    [`${SITE}/browse/ACME-12345?atlOrigin=abc`, "ACME-12345"],
    [`${SITE}/jira/software/c/projects/ACME/issues/ACME-12345`, "ACME-12345"],
    [
      `${SITE}/jira/software/c/projects/ACME/boards/551?selectedIssue=ACME-12345`,
      "ACME-12345",
    ],
    [
      `${SITE}/jira/plans/12/scenarios/12/timeline?selectedIssue=ACME-12345`,
      "ACME-12345",
    ],
  ])("accepts %s", (url, key) => {
    const { onAdd, paste } = setup();
    paste(url);
    expect(onAdd).toHaveBeenCalledWith({ url, key, baseUrl: SITE });
  });

  it("accepts a bare key once a Jira site is configured", () => {
    const { onAdd, paste } = setup(SITE);
    paste("ACME-42");
    expect(onAdd).toHaveBeenCalledWith({
      url: "ACME-42",
      key: "ACME-42",
      baseUrl: SITE,
    });
  });

  it("asks for the Jira URL when a bare key arrives with nothing configured", () => {
    const { onAdd, paste } = setup();
    paste("ACME-42");
    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      /Jira URL in Settings/i,
    );
  });

  it("rejects a link that is not a Jira site", () => {
    const { onAdd, paste } = setup();
    paste("https://evil.example/browse/ACME-1");
    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      /doesn't point at a Jira site/i,
    );
  });

  it("rejects a Jira link that carries no issue key", () => {
    const { onAdd, paste } = setup(SITE);
    paste(`${SITE}/jira/software/c/projects/ACME/boards/551`);
    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/no issue key/i);
  });

  it("rejects text that is neither a link nor a key", () => {
    const { onAdd, paste } = setup(SITE);
    paste("just some words");
    expect(onAdd).not.toHaveBeenCalled();
    // Not a link and not a key: the message must name both remedies rather
    // than assert it was one of them.
    expect(screen.getByRole("alert")).toHaveTextContent(
      /can't tell which Jira site/i,
    );
  });

  it("clears the error as soon as the user edits again", () => {
    const { input, paste } = setup(SITE);
    paste("nonsense");
    expect(screen.getByRole("alert")).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "ACME-1" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("submits on Enter, not only by clicking the button", async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    render(<AddTrackerForm fallbackBaseUrl={SITE} onAdd={onAdd} />);
    await user.click(screen.getByLabelText("Initiative link or key"));
    await user.keyboard("ACME-9{Enter}");
    expect(onAdd).toHaveBeenCalledWith({
      url: "ACME-9",
      key: "ACME-9",
      baseUrl: SITE,
    });
  });

  it("empties the field after a successful add", () => {
    const { input, paste } = setup();
    paste(`${SITE}/browse/ACME-1`);
    expect((input as HTMLInputElement).value).toBe("");
  });
});
