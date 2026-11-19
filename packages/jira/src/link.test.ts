import { describe, it, expect } from "vitest";
import { isIssueKey, parseIssueLink } from "./link";

const SITE = "https://acme.atlassian.net";

function ok(input: string, fallback?: string) {
  const res = parseIssueLink(input, fallback);
  if (!res.ok) throw new Error(`expected ok, got ${res.reason}`);
  return res;
}

function fail(input: string, fallback?: string) {
  const res = parseIssueLink(input, fallback);
  if (res.ok) throw new Error(`expected failure, got ${res.key}`);
  return res.reason;
}

describe("parseIssueLink", () => {
  it("parses a browse link", () => {
    expect(ok(`${SITE}/browse/ACME-12345`)).toEqual({
      ok: true,
      baseUrl: SITE,
      key: "ACME-12345",
    });
  });

  it("ignores a query string on a browse link", () => {
    expect(ok(`${SITE}/browse/ACME-12345?atlOrigin=eyJpIjoiZm9vIn0`).key).toBe(
      "ACME-12345",
    );
  });

  it("parses the new issue view under a project", () => {
    const res = ok(`${SITE}/jira/software/c/projects/ACME/issues/ACME-12345`);
    expect(res).toEqual({ ok: true, baseUrl: SITE, key: "ACME-12345" });
  });

  it("parses a board link with the issue selected", () => {
    const res = ok(
      `${SITE}/jira/software/c/projects/ACME/boards/551` +
        "?selectedIssue=ACME-12345",
    );
    expect(res.key).toBe("ACME-12345");
  });

  it("parses a plan timeline link with the issue selected", () => {
    const res = ok(
      `${SITE}/jira/plans/123/scenarios/123/timeline?selectedIssue=ACME-12345`,
    );
    expect(res.key).toBe("ACME-12345");
  });

  it("prefers a key in the path over selectedIssue", () => {
    expect(ok(`${SITE}/browse/ACME-1?selectedIssue=OTHER-2`).key).toBe(
      "ACME-1",
    );
  });

  it("takes a bare key with the configured site as fallback", () => {
    expect(ok("ACME-12345", SITE)).toEqual({
      ok: true,
      baseUrl: SITE,
      key: "ACME-12345",
    });
  });

  it("trims whitespace around the input", () => {
    expect(ok("  ACME-12345\n", `${SITE}/`).key).toBe("ACME-12345");
    expect(ok(`\t${SITE}/browse/ACME-1  `).key).toBe("ACME-1");
  });

  it("reduces a fallback with a path to its origin", () => {
    expect(ok("ACME-7", `${SITE}/jira/software/projects/ACME`).baseUrl).toBe(
      SITE,
    );
  });

  it("rejects a bare key with no site to attach it to", () => {
    expect(fail("ACME-12345")).toBe("no-host");
    expect(fail("ACME-12345", "   ")).toBe("no-host");
    expect(fail("ACME-12345", "not a url")).toBe("no-host");
  });

  it("rejects a link on a host that is not Jira Cloud", () => {
    expect(fail("https://evil.example/browse/X-1")).toBe("untrusted-host");
  });

  it("rejects a look-alike host", () => {
    expect(fail("https://atlassian.net.evil.example/browse/ACME-1")).toBe(
      "untrusted-host",
    );
    expect(fail("https://notatlassian.net/browse/ACME-1")).toBe(
      "untrusted-host",
    );
  });

  it("rejects a bare key whose fallback site is untrusted", () => {
    expect(fail("ACME-1", "https://evil.example")).toBe("untrusted-host");
  });

  it("accepts a custom host only when it is explicitly allowed", () => {
    const url = "https://jira.acme.com/browse/ACME-1";
    expect(parseIssueLink(url)).toEqual({
      ok: false,
      reason: "untrusted-host",
    });
    expect(
      parseIssueLink(url, undefined, { allowedHosts: ["JIRA.acme.com "] }),
    ).toEqual({ ok: true, baseUrl: "https://jira.acme.com", key: "ACME-1" });
  });

  it("reports a trusted link with nothing key-shaped in it", () => {
    expect(fail(`${SITE}/jira/dashboards/10000`)).toBe("no-key");
    expect(fail("")).toBe("no-key");
    expect(fail("   ")).toBe("no-key");
  });

  it("rescues a link pasted without its scheme", () => {
    expect(ok("acme.atlassian.net/browse/ACME-1")).toEqual({
      ok: true,
      baseUrl: SITE,
      key: "ACME-1",
    });
  });

  it("refuses a non-http scheme", () => {
    expect(fail("javascript:alert(1)//acme.atlassian.net/browse/ACME-1")).toBe(
      "no-host",
    );
  });

  it("keeps a non-default port on the base URL", () => {
    const res = parseIssueLink(
      "https://jira.acme.com:8443/browse/ACME-1",
      undefined,
      { allowedHosts: ["jira.acme.com"] },
    );
    expect(res).toEqual({
      ok: true,
      baseUrl: "https://jira.acme.com:8443",
      key: "ACME-1",
    });
  });
});

describe("isIssueKey", () => {
  it("accepts well-formed keys only", () => {
    expect(isIssueKey("ACME-1")).toBe(true);
    expect(isIssueKey("AB_C2-1234")).toBe(true);
    expect(isIssueKey("A-1")).toBe(false); // needs 2+ leading chars
    expect(isIssueKey("acme-1")).toBe(false);
    expect(isIssueKey("ACME-1 OR 1=1")).toBe(false);
    expect(isIssueKey('ACME-1") OR x IN ("Y-2')).toBe(false);
    expect(isIssueKey(42)).toBe(false);
  });
});
