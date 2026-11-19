import { describe, expect, it } from "vitest";
import { accessOptionsFromEnv, isAllowedHost, isAllowedOrigin } from "./access";

const none = { allowedHosts: [] };
const team = { allowedHosts: ["planner.example.com"] };

describe("isAllowedHost", () => {
  it("accepts loopback names and IP literals", () => {
    for (const host of [
      "localhost:5191",
      "127.0.0.1:5191",
      "[::1]:5191",
      "planner.localhost:5191",
      "192.168.1.20:5191",
      undefined,
    ]) {
      expect(isAllowedHost(host, none)).toBe(true);
    }
  });

  it("rejects a DNS name unless listed (DNS rebinding)", () => {
    expect(isAllowedHost("evil.example:5191", none)).toBe(false);
    expect(isAllowedHost("planner.example.com", none)).toBe(false);
    expect(isAllowedHost("planner.example.com", team)).toBe(true);
    expect(isAllowedHost("PLANNER.example.com:443", team)).toBe(true);
  });
});

describe("isAllowedOrigin", () => {
  it("lets non-browser clients through", () => {
    expect(isAllowedOrigin(undefined, "localhost:5191", none)).toBe(true);
  });

  it("accepts loopback pages and the packaged Mac app", () => {
    expect(
      isAllowedOrigin("http://localhost:5190", "localhost:5191", none),
    ).toBe(true);
    expect(
      isAllowedOrigin("http://127.0.0.1:5191", "127.0.0.1:5191", none),
    ).toBe(true);
    expect(isAllowedOrigin("http://[::1]:5190", "[::1]:5191", none)).toBe(true);
    expect(isAllowedOrigin("file://", "127.0.0.1:5191", none)).toBe(true);
  });

  it("refuses another website", () => {
    expect(
      isAllowedOrigin("https://evil.example", "localhost:5191", none),
    ).toBe(false);
    expect(
      isAllowedOrigin("chrome-extension://abc", "localhost:5191", none),
    ).toBe(false);
    expect(isAllowedOrigin("not a url", "localhost:5191", none)).toBe(false);
  });

  it("accepts its own origin when reached by IP from another machine", () => {
    expect(
      isAllowedOrigin("http://192.168.1.20:5191", "192.168.1.20:5191", none),
    ).toBe(true);
    // ...but not a rebinding name that merely matches the Host header.
    expect(
      isAllowedOrigin("http://evil.example:5191", "evil.example:5191", none),
    ).toBe(false);
  });

  it("accepts listed team hosts", () => {
    expect(
      isAllowedOrigin(
        "https://planner.example.com",
        "planner.example.com",
        team,
      ),
    ).toBe(true);
  });
});

describe("accessOptionsFromEnv", () => {
  it("splits and normalises PLANNER_ALLOWED_HOSTS", () => {
    expect(
      accessOptionsFromEnv({
        PLANNER_ALLOWED_HOSTS: " A.example.com, b.example.com ,",
      }).allowedHosts,
    ).toEqual(["a.example.com", "b.example.com"]);
    expect(accessOptionsFromEnv({}).allowedHosts).toEqual([]);
  });
});
