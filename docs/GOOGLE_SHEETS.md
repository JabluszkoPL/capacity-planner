# Sending a plan to Google Sheets

The **📗 Send to Google Sheets** button (in a project's _Run plan_ section, next
to _Export to Excel_) creates a brand-new Google spreadsheet from the current
plan — with the **Assignments**, **By Person**, **By Task**, and **Unassigned**
tabs, cell colors, and frozen headers.

It runs entirely in the browser (no server). It signs you in with Google and
calls the Sheets API directly. That requires a one-time setup: your own Google
OAuth client ID.

## One-time setup

1. **Create / pick a Google Cloud project**
   Go to <https://console.cloud.google.com/> and create a project (or reuse one).

2. **Enable the Google Sheets API**
   APIs & Services → Library → search "Google Sheets API" → **Enable**.

3. **Configure the OAuth consent screen** (if you haven't already)
   APIs & Services → OAuth consent screen → **External** → fill in the app name
   and your email. Add your Google account under **Test users** (that's enough
   while the app stays unverified — no Google review is needed for the
   `drive.file` scope this app uses).

4. **Create an OAuth 2.0 Client ID**
   APIs & Services → Credentials → **Create credentials → OAuth client ID** →
   Application type: **Web application**.
   Under **Authorized JavaScript origins**, add every origin the app runs on,
   e.g.:
   - `http://localhost:5179` (the dev server)
   - your deployed URL, e.g. `https://planner.example.com`

   Copy the generated **Client ID** (looks like
   `1234567890-abc123.apps.googleusercontent.com`).

5. **Add it to the app's environment**
   Create a `.env` file in the project root:

   ```
   VITE_GOOGLE_CLIENT_ID=1234567890-abc123.apps.googleusercontent.com
   ```

   Restart the dev server (`npm run dev`) so Vite picks it up.
   `.env` is git-ignored (via `*.local` — name it `.env.local` if you prefer).

## Using it

1. Run a plan.
2. Click **📗 Send to Google Sheets**.
3. The first time, Google shows a consent popup — approve the `drive.file`
   scope (the app can only see files it creates).
4. A new spreadsheet opens in a new tab.

## Scope & privacy

- Scope: `https://www.googleapis.com/auth/drive.file` — the app can only create
  and edit spreadsheets **it** makes; it cannot read your other Drive files.
- Nothing is stored server-side; the access token lives only in the browser tab
  and is discarded when you close it.

## Troubleshooting

- **"Google Sheets isn't configured"** — `VITE_GOOGLE_CLIENT_ID` is missing;
  add it to `.env` and restart the dev server.
- **`redirect_uri_mismatch` / origin errors** — the current origin isn't in the
  client ID's _Authorized JavaScript origins_. Add it and wait a minute.
- **`access_denied`** — your Google account isn't a **Test user** on the consent
  screen, or you dismissed the popup. Add yourself and retry.
- **Popup blocked** — allow popups for the app's origin, then click again.
