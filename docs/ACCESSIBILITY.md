# Accessibility & keyboard walkthrough

The whole app is operable without a mouse. Every interactive element is
reachable via `Tab` / `Shift+Tab`, and shows a visible focus ring
(`--focus-ring`, defined in `apps/web/src/styles/tokens.css` and applied globally in
`apps/web/src/styles/global.css` to inputs, buttons, links, `[role="button"]`, and any
`[tabindex]` element).

## Global

- **Tab / Shift+Tab** — move forward / backward through every control.
- **Sidebar** — `Projects`, `Teams` and `Tracking` are links (the current
  one has `aria-current="page"`). At the bottom: the sync status (text, not
  just a dot), **Jira** and **Settings** buttons.
- **View tabs** — a project or a tracker shows its views as a row of links
  under the page header, in a labelled `nav` ("Project views" / "Tracker
  views"); the current one has `aria-current="page"`. Each view has its own
  URL (`?view=`).
- **Modals** (New project, Paste import, Confirm dialog, Settings…) — open with
  focus moved into the panel; `Esc` closes; `Tab` cycles the controls; on
  close, focus returns to the element that opened it. A backdrop click also
  closes, but a click on content inside the panel does not. Every modal also
  has a corner **Close dialog** button, last in the tab order.
- **Theme** — Settings → General → Appearance: System (follows the device's
  light/dark setting), Light or Dark. In both palettes body text, muted
  text, links, primary-button labels and the warning/danger strips meet WCAG
  AA (4.5:1) on their backgrounds.
- **Segmented toggles** (Person / Task / Epic, Balanced / Smart) are
  radiogroups: one tab stop, **Arrow keys** move and select.
- **Toasts** — announced via `role="status"` / `aria-live="polite"`.

## Projects dashboard (`/`)

1. **New project** in the page header opens a modal with focus in **Name**;
   Tab to **Start date**; **Enter** (or **Create project**) creates the project
   and navigates into it.
2. A **Search projects** box and, with several teams, a team filter narrow the
   cards; **Clear filters** appears when nothing matches.
3. Each project card: the **title** is a `role="button"` (Enter/Space opens),
   then **Open**, **Copy**, **Export {name}** and **Delete {name}**. Delete
   opens the confirm dialog.
4. Empty roster shows a written empty state, never a blank area.

## Project detail (`/project/:id`)

The page is split into views, picked from the tabs under its header:
Overview, Epics & tasks, Teams & people, Plan & timeline, Settings.

- **Project name** is edited in place in the Overview header and under
  Settings; it commits on blur/Enter. **Start date**, the **Project accent**
  swatches (`aria-pressed`) and the comment are under Settings.
- **Paste from Sheets** (Epics & tasks) opens the import modal (target-epic
  `select`, textarea, a read-only parsed preview, Cancel/Import — all
  tabbable; Esc cancels).
- **Epics & Tasks**: **Add epic**, **Expand all / Collapse all**; per epic the
  ▲/▼ reorder buttons, the inline **Epic name**, **Add task to {epic}**, and
  delete (confirm). Per task row: ▲/▼,
  **Task name**, **Estimate**, **Specialization**, the
  Included/Skipped chip (`aria-pressed`, Space toggles), and delete.
  All text fields commit on **blur** or **Enter** — typing never loses focus.
- **Specialization fields** (tasks and helpers) are comboboxes: a click or
  **ArrowDown** opens every specialization held by the project's selected teams
  (all teams when none is selected), typing filters, **ArrowUp/ArrowDown** move,
  **Enter** picks, **Esc** closes the list. Any other value can still be typed.
- **Plan & timeline**: the planning mode (Balanced / Smart radiogroup), the
  sliders, the **Run plan** button; the **Person / Task / Epic** radiogroup
  over the timeline; the assignments table.

## Teams (`/team`)

- Each roster row: **name** and **specialization** inputs (commit on
  blur/Enter) and a **Remove** button (confirm; also clears their off-days).
- **Add person** form: blank name is rejected inline via `role="alert"`.
- **Availability grid**: weekday cells are focusable (`tabIndex=0`,
  `aria-pressed` reflects off/on). **Enter/Space** toggles the focused day.
  Mouse users can also click a day or click-drag across a row to paint several
  days at once. Weekend cells are non-interactive and not in the tab order.

## Tracker detail (`/tracking/:id`)

- **Plan task** pickers in the task comparison are searchable comboboxes: a
  click, **ArrowDown** or **Enter** opens every plan task grouped by epic,
  typing filters by task or epic name and highlights the first match,
  **ArrowUp/ArrowDown** move, **Enter** picks, **Esc** closes the list.
  Leaving the field without picking keeps the current mapping.

## Settings dialog

- Opened from **Settings** at the bottom of the sidebar (its accessible name is
  "About Planner"). The section list (General, Sync & sharing, Backup, AI
  assistants, About) is a vertical `tablist`: one tab stop, **Arrow keys** move
  and select, **Home/End** jump to the ends; each section is a `tabpanel`.

### AI assistants (Mac app)

- **Allow AI clients to connect** and **Allow changes…** are native checkboxes
  (Space toggles); the second is disabled until the first is on. The server's
  state ("Listening at…", or why it couldn't start) is a `role="status"` line
  the first checkbox points to with `aria-describedby`.
- The **Copy for Claude Code / Codex / JSON config** buttons sit in a labelled
  group; after a copy a polite live region says what was copied. **New token**
  is a plain button. The token itself is never shown on screen.
- Changes an AI client makes appear as toasts ("AI assistant: …"), announced
  like any other.

## Responsiveness

Down to ~1024px the page itself never scrolls horizontally. Wide content — the
gantt charts, the availability grid, the assignments table, and the epic task
tables — each scroll inside their own `overflow-x: auto` container.
