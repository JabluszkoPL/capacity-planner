/**
 * Ad-hoc sign the packaged app.
 *
 * electron-builder's `identity` field only takes the *name* of a real
 * certificate — it treats "-" as a name to look up, fails to find it, and
 * skips signing. Without any signature an Apple Silicon Mac reports the app as
 * "damaged and can't be opened", which looks far worse than the Gatekeeper
 * prompt an unidentified developer is supposed to produce.
 *
 * An ad-hoc signature fixes that. It does not make the app trusted — there is
 * no identity behind it — so the recipient still clears Gatekeeper once by
 * hand. It only makes the bundle internally consistent.
 *
 * This runs before the .dmg and .zip are assembled, so they contain the signed
 * app rather than the raw one.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";

export default async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;

  // A universal build packs x64 and arm64 into "-temp" directories and lipos
  // them together afterwards. Signing those intermediates would be undone by
  // the merge, so only the merged bundle is signed.
  if (context.appOutDir.endsWith("-temp")) return;

  const appPath = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );

  console.log(`[planner] ad-hoc signing ${appPath}`);
  execFileSync(
    "codesign",
    ["--force", "--deep", "--sign", "-", "--timestamp=none", appPath],
    { stdio: "inherit" },
  );
  execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], {
    stdio: "inherit",
  });
}
