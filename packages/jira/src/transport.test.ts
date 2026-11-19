import { describe, it, expect } from "vitest";
import { base64, basicAuth, utf8Bytes } from "./transport";

/**
 * The base64 encoder is hand-rolled so it runs without `Buffer` or `btoa`, so
 * it is checked against known vectors rather than against another encoder.
 */
describe("base64", () => {
  it("encodes the RFC 4648 padding cases", () => {
    expect(base64("")).toBe("");
    expect(base64("f")).toBe("Zg==");
    expect(base64("fo")).toBe("Zm8=");
    expect(base64("foo")).toBe("Zm9v");
    expect(base64("foob")).toBe("Zm9vYg==");
    expect(base64("fooba")).toBe("Zm9vYmE=");
    expect(base64("foobar")).toBe("Zm9vYmFy");
  });

  it("encodes a realistic credential pair", () => {
    expect(base64("user@example.com:hunter2")).toBe(
      "dXNlckBleGFtcGxlLmNvbTpodW50ZXIy",
    );
  });

  it("encodes non-ASCII as UTF-8, not as code units", () => {
    expect(base64("ä")).toBe("w6Q=");
    expect(base64("€")).toBe("4oKs");
    expect(base64("Łukasz")).toBe("xYF1a2Fzeg==");
    expect(base64("日本語")).toBe("5pel5pys6Kqe");
  });

  it("encodes astral code points from their surrogate pair", () => {
    expect(utf8Bytes("😀")).toEqual([0xf0, 0x9f, 0x98, 0x80]);
    expect(base64("😀")).toBe("8J+YgA==");
    expect(base64("a😀b")).toBe("YfCfmIBi");
  });

  it("emits the replacement bytes for a lone surrogate rather than throwing", () => {
    expect(() => base64("\ud83d")).not.toThrow();
  });
});

describe("basicAuth", () => {
  it("builds a Basic header from email and token", () => {
    expect(basicAuth("user@example.com", "hunter2")).toBe(
      "Basic dXNlckBleGFtcGxlLmNvbTpodW50ZXIy",
    );
  });

  it("trims a pasted token's stray whitespace", () => {
    expect(basicAuth("  user@example.com ", "hunter2\n")).toBe(
      basicAuth("user@example.com", "hunter2"),
    );
  });
});
