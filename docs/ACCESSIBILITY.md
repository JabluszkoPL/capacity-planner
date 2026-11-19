# Accessibility & keyboard walkthrough

The whole app is operable without a mouse. Every interactive element is
reachable via `Tab` / `Shift+Tab`, and shows a visible focus ring
(`--focus-ring`, defined in `apps/web/src/styles/tokens.css` and applied globally in
`apps/web/src/styles/global.css` to inputs, buttons, links, `[role="button"]`, and any
`[tabindex]` element).

## Global

- **Tab / Shift+Tab** — move forward / backward through every control.
- **Header nav** — `Projects` and `Team` are links; `Enter` activates.
- **Modals** (Paste import, Confirm dialog) — open with focus moved into the
  panel; `Esc` closes; `Tab` cycles the controls; on close, focus returns to the
  element that opened it. A backdrop click also closes, but a click on content
  inside the panel does not.
- **Toasts** — announced via `role="status"` / `aria-live="polite"`.

## Projects dashboard (`/`)

1. Tab to **Name**, type; Tab to **Start date**; **Enter** (or Tab to the
   button and Enter) creates the project and navigates into it.
2. Each project card: the **title** is a `role="button"` (Enter/Space opens),
   then **Open**, **Copy**, **Delete**. Delete opens the confirm dialog.
3. Empty roster shows a written empty state, never a blank area.

## Project detail (`/project/:id`)

- **Project name** and **Start date** at the top; name commits on blur/Enter.
- **Paste from Sheets** opens the import modal (target-epic `select`, textarea,
  Cancel/Import — all tabbable; Esc cancels).
- **Epics & Tasks**: `+ Add epic`; per epic the ▲/▼ reorder buttons, the
  inline **Epic name**, `+ Task`, and delete (confirm). Per task row: ▲/▼,
  **Task name**, **Estimate**, **Specialization**, the
  Included/Skipped chip (`aria-pressed`, Space toggles), and delete.
  All text fields commit on **blur** or **Enter** — typing never loses focus.
- **Specialization fields** (tasks and helpers) are comboboxes: a click or
  **ArrowDown** opens every specialization held by the project's selected teams
  (all teams when none is selected), typing filters, **ArrowUp/ArrowDown** move,
  **Enter** picks, **Esc** closes the list. Any other value can still be typed.
- **Run plan**: the **Run Plan** button; the **Grid by Person / Grid by Task**
  segmented toggle (`aria-pressed`); the assignments table.

## Team (`/team`)

- Each member chip: **name** and **specialization** inputs (commit on
  blur/Enter) and a **Remove** button (confirm; also clears their off-days).
- **Add member** form: blank name is rejected inline via `role="alert"`.
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

## About panel - AI assistants (Mac app)

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
