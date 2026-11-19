/**
 * electron-builder stamps the bundle (and names the .zip the updater looks
 * for) from apps/desktop/package.json, while the app reports the root
 * package.json version. If they drifted, a freshly installed update would
 * report the old version and offer itself again forever.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) =>
  JSON.parse(readFileSync(resolve(__dirname, p), "utf8")) as {
    version: string;
  };

describe("versions", () => {
  it("match across the workspace (use `pnpm version:set`)", () => {
    const root = read("../../../package.json").version;
    expect(read("../package.json").version).toBe(root);
    expect(read("../../web/package.json").version).toBe(root);
    expect(read("../../server/package.json").version).toBe(root);
  });
});
