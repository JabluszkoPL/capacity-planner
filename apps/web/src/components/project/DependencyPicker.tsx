import { useMemo, useState } from "react";
import {
  type Epic,
  type ID,
  type TaskItem,
  tasksWaitingOn,
} from "@planner/core";
import { Button } from "../ui/Button";

interface DependencyPickerProps {
  /** The task whose dependencies are being edited. */
  task: TaskItem;
  allEpics: Epic[];
  /** Replace the task's dependency list with `ids`. */
  onChange: (ids: ID[]) => void;
}

/**
 * Checklist of every other task in the project, grouped by epic.
 *
 * Each epic heading carries a tri-state checkbox that selects or clears all of
 * that epic's (visible) tasks at once, so the usual flow for a QA task is:
 * tick the feature epics, then untick the individual tasks it shouldn't wait
 * for. "Select all" / "Clear" do the same across everything shown, and both
 * respect the search filter, which matches task names and epic names (an
 * epic match shows all of that epic's tasks).
 *
 * Tasks that already wait on this one (directly, transitively or through an
 * epic dependency) are disabled: depending on them would close a loop, and the
 * scheduler leaves every task in a loop unassigned. One that is already
 * checked stays enabled so an existing loop can be broken from here.
 */
export function DependencyPicker({
  task,
  allEpics,
  onChange,
}: DependencyPickerProps) {
  const [query, setQuery] = useState("");
  const deps = task.dependsOn ?? [];
  const depSet = new Set(deps);
  const waiting = useMemo(
    () => tasksWaitingOn(allEpics, task.id),
    [allEpics, task.id],
  );
  const blocked = (t: TaskItem) => waiting.has(t.id) && !depSet.has(t.id);

  const hasAnyOption = allEpics.some((e) =>
    e.tasks.some((t) => t.id !== task.id),
  );
  if (!hasAnyOption)
    return (
      <div className="dep-picker">
        <p className="muted">No other tasks to depend on yet.</p>
      </div>
    );

  const q = query.trim().toLowerCase();
  // A query matching the epic's name shows all of its tasks; otherwise only
  // the tasks whose own name matches.
  const groups = allEpics
    .map((e) => {
      const epicMatches = q === "" || e.name.toLowerCase().includes(q);
      return {
        epic: e,
        options: e.tasks.filter(
          (t) =>
            t.id !== task.id &&
            (epicMatches || t.name.toLowerCase().includes(q)),
        ),
      };
    })
    .filter((g) => g.options.length > 0);
  const shown = groups.flatMap((g) => g.options);

  const select = (tasks: TaskItem[]) =>
    onChange([
      ...deps,
      ...tasks.filter((t) => !blocked(t) && !depSet.has(t.id)).map((t) => t.id),
    ]);
  const clear = (tasks: TaskItem[]) => {
    const drop = new Set(tasks.map((t) => t.id));
    onChange(deps.filter((id) => !drop.has(id)));
  };
  const toggle = (t: TaskItem) => (depSet.has(t.id) ? clear([t]) : select([t]));

  const shownSelectable = shown.filter((t) => !blocked(t));
  const allShownOn =
    shownSelectable.length > 0 &&
    shownSelectable.every((t) => depSet.has(t.id));
  const anyShownOn = shown.some((t) => depSet.has(t.id));

  return (
    <>
      <input
        type="text"
        className="dep-search"
        aria-label="Search tasks and epics"
        placeholder="Search tasks or epics…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.preventDefault();
        }}
      />
      <div className="dep-toolbar">
        <span className="muted" aria-live="polite">
          {deps.length} selected
        </span>
        <Button
          small
          disabled={allShownOn || shownSelectable.length === 0}
          onClick={() => select(shown)}
        >
          {q ? "Select matching" : "Select all"}
        </Button>
        <Button small disabled={!anyShownOn} onClick={() => clear(shown)}>
          {q ? "Clear matching" : "Clear"}
        </Button>
      </div>
      <div className="dep-picker">
        {groups.length === 0 ? (
          <p className="muted">No tasks match “{query.trim()}”.</p>
        ) : (
          groups.map(({ epic: e, options }) => {
            const selectable = options.filter((t) => !blocked(t));
            const onCount = options.filter((t) => depSet.has(t.id)).length;
            const allOn =
              selectable.length > 0 &&
              selectable.every((t) => depSet.has(t.id));
            const someOn = onCount > 0 && !allOn;
            return (
              <div key={e.id} className="dep-group">
                <label className="dep-group-title">
                  <input
                    type="checkbox"
                    aria-label={`All tasks in ${e.name}`}
                    checked={allOn}
                    disabled={selectable.length === 0 && onCount === 0}
                    ref={(el) => {
                      if (el) el.indeterminate = someOn;
                    }}
                    onChange={() => (allOn ? clear(options) : select(options))}
                  />
                  <span className="dep-group-name">{e.name}</span>
                  <span className="dep-group-count">
                    {onCount}/{options.length}
                  </span>
                </label>
                {options.map((t) => (
                  <label
                    key={t.id}
                    className={"dep-option" + (blocked(t) ? " blocked" : "")}
                  >
                    <input
                      type="checkbox"
                      checked={depSet.has(t.id)}
                      disabled={blocked(t)}
                      onChange={() => toggle(t)}
                    />
                    <span>{t.name}</span>
                    {t.excluded && <span className="dep-tag">skipped</span>}
                    {waiting.has(t.id) && (
                      <span className="dep-tag">waits on this task</span>
                    )}
                  </label>
                ))}
              </div>
            );
          })
        )}
      </div>
    </>
  );
}
