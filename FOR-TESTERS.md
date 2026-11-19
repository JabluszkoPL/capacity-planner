# Testing Planner (web version)

1. Install **Node.js 22 or newer** from <https://nodejs.org> (pick "LTS") if
   you don't have it.
2. Unzip this folder anywhere.
3. **Right-click `Start Planner.command` → Open**, then click **Open** in the
   dialog. (A plain double-click is blocked the first time because the file
   was downloaded; after that, double-click works.)
4. A Terminal window appears. The first run installs a few things and takes a
   minute; then Planner opens in your browser at <http://localhost:5190>.

To stop it, close the Terminal window. Your data stays in the browser, so it
is still there next time you start it.

If macOS still refuses to open the file, run this once in Terminal from the
unzipped folder:

    xattr -dr com.apple.quarantine .
