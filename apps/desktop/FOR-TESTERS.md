# Planner — installing the Mac app

This build is **not signed by Apple**, so macOS will
block it the first time and you have to allow it by hand — once. After that it
opens normally like any other app.

Nothing is wrong with the app; this is just what macOS does with software that
did not come from the App Store or a registered developer.

## Install

1. Open the **Planner-…-universal.dmg** and drag **Planner** into
   **Applications**.
2. Double-click Planner. macOS will refuse to open it — that is expected.
3. Open **System Settings → Privacy & Security**, scroll down to the
   **Security** section. There will be a line saying _"Planner was blocked…"_
   with an **Open Anyway** button. Click it.
4. Double-click Planner again and confirm **Open**.

That is it. macOS remembers the choice — you will not be asked again.

### If step 3 shows nothing

Some macOS versions only show the button for a few minutes after the failed
launch. Try double-clicking Planner again, then look in Privacy & Security
straight away.

### Faster route, if you are comfortable with Terminal

Open Terminal and paste this, then press Return:

```
xattr -dr com.apple.quarantine /Applications/Planner.app
```

Planner will then open on a normal double-click, no System Settings needed.

## What to expect

- It works on **any Mac** — Apple Silicon and Intel both.
- It runs **entirely on your machine**. No account, no sign-in, nothing is
  uploaded. It works with the Wi-Fi off.
- **It updates itself.** When a new version is published, the version number
  in the top bar turns into "Update to …". Click it, then **Download and
  install**, then **Restart now**. This only works when Planner is in your
  Applications folder.
- **Your data in a browser too.** While Planner is open, go to
  <http://localhost:5191> in Safari or Chrome to see and edit the same
  projects. Only this Mac can reach that address.
- It starts with a **Sample Project** so there is something to poke at. Delete
  it whenever; your own projects are kept separately.
- Your data lives in `~/Library/Application Support/Planner/planner.sqlite`.
  Deleting the app does not delete that file — delete the folder too if you
  want a completely clean slate.

## Uninstalling

Drag Planner from Applications to the Bin, and delete
`~/Library/Application Support/Planner` if you want the data gone as well.

## Feedback

It is an early build, so rough edges are expected. Report anything confusing,
anything that looks wrong in the plan or the timeline, and anything you
expected to be able to do and could not, as an issue on the project's GitHub
page.
