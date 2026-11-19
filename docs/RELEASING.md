# Releasing

A release is a git tag. Pushing `v0.2.0` runs
[`.github/workflows/release.yml`](../.github/workflows/release.yml) on a macOS
runner, which tests, builds the universal `.dmg` and `.zip`, and publishes them
as a GitHub release. Every installed Mac app checks for that release and offers
to install it.

## Cutting one

```bash
pnpm version:set 0.2.0
git commit -am "Release v0.2.0"
git tag v0.2.0
git push && git push --tags
```

`version:set` writes the version into the root `package.json` (the source of
truth the app reads at build time) and the copies in `apps/*/package.json`
(electron-builder names the files and stamps `Info.plist` from the desktop
one). A test fails if they drift, and the workflow refuses a tag that doesn't
match.

Edit the generated release notes on GitHub afterwards if you want — the app's
"What's new" link opens that page.

## How the Mac app updates itself

`apps/desktop/electron/updater.ts`, roughly 15 seconds after launch and every 6
hours:

1. `GET https://api.github.com/repos/<repo>/releases/latest`. The repository
   comes from the root `package.json` `repository` field, so a fork that changes
   it updates from its own releases.
2. If that version is newer, the version in the header turns into **Update to
   vX.Y.Z**. The About panel offers **Download and install**.
3. The `*-universal-mac.zip` is downloaded from this repository's release
   assets only, then checked: byte size, the SHA-256 digest GitHub reports for
   the asset, `codesign --verify`, and the version in its `Info.plist`.
4. **Restart now** quits the app; a small script waits for it to exit, swaps
   the new `Planner.app` in place of the old one (restoring the old one if the
   move fails), and reopens it. The database is in
   `~/Library/Application Support/Planner` and is not touched.

It installs in place only when Planner runs from a folder it can write to
(normally `/Applications`). Run from the disk image or from a quarantined,
translocated copy, the panel explains why and links to the release instead.

### Why not electron-updater

Squirrel.Mac, which electron-updater uses on macOS, only accepts an update
whose code signature satisfies the running app's designated requirement. The
builds are ad-hoc signed (no Developer ID — see [DESKTOP.md](DESKTOP.md)), so
there is no stable requirement and Squirrel refuses every update. Once there is
a Developer ID and notarization, switching to electron-updater is reasonable.

## Running from source instead

People who run `pnpm dev:web` or `pnpm serve` from a clone see the same
"update available" notice in the browser; for them updating is:

```bash
git pull
pnpm install
```
