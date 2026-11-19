/**
 * Set Planner's version everywhere it is written down.
 *
 *   pnpm version:set 0.2.0
 *
 * The root package.json is the source of truth: the web bundle and the Mac
 * app's main process both read it at build time. The app packages carry a
 * copy only because electron-builder names the .dmg/.zip and stamps the
 * bundle's Info.plist from apps/desktop/package.json — a test fails if the
 * copies ever drift.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = (process.argv[2] ?? "").replace(/^v/, "");

if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("Usage: pnpm version:set <major.minor.patch>, e.g. 0.2.0");
  process.exit(1);
}

for (const file of [
  "package.json",
  "apps/desktop/package.json",
  "apps/web/package.json",
  "apps/server/package.json",
]) {
  const path = resolve(root, file);
  const text = readFileSync(path, "utf8");
  const updated = text.replace(/("version":\s*")[^"]*(")/, `$1${version}$2`);
  writeFileSync(path, updated);
  console.log(`${file} -> ${version}`);
}

console.log(`\nNext: commit, then tag and push to publish a release:`);
console.log(`  git commit -am "Release v${version}"`);
console.log(`  git tag v${version} && git push && git push --tags`);
