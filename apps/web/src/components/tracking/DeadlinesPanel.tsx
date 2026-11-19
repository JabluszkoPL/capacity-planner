import { useId } from "react";
import {
  suggestedEndPhase,
  type Project,
  type ResolvedDeadlines,
  type TrackerDeadlines,
} from "@planner/core";
import { Button } from "../ui/Button";

interface DeadlinesPanelProps {
  project: Project;
  /** What the tracker stored; absent = everything from the plan. */
  deadlines: TrackerDeadlines | undefined;
  /** The same with the plan's dates filled in, from the current status. */
  resolved: ResolvedDeadlines | null;
  onChange: (next: TrackerDeadlines) => void;
}

/**
 * The dates the tracker judges progress against.
 *
 * Every date is filled in from the baseline plan, and each can be switched to
 * a custom one. Nothing is left blank, so what the tracker is measuring
 * against is always on screen.
 */
export function DeadlinesPanel({
  project,
  deadlines,
  resolved,
  onChange,
}: DeadlinesPanelProps) {
  const id = useId();
  const current = deadlines ?? {};
  const endPhase = current.endPhase ?? [];
  const specs = [
    ...new Set(
      project.epics.flatMap((e) => e.tasks.map((t) => t.specialization)),
    ),
  ].filter(Boolean);
  const development = specs.filter((s) => !endPhase.includes(s));
  const suggested = suggestedEndPhase(project).filter(
    (s) => !endPhase.includes(s),
  );
  const set = (patch: Partial<TrackerDeadlines>) =>
    onChange({ ...current, ...patch });

  return (
    <section className="deadlines-panel" aria-labelledby={`${id}-title`}>
      <h2 className="section-title" id={`${id}-title`}>
        Deadlines
      </h2>
      <p className="muted deadlines-intro">
        Taken from the baseline plan. Pick <strong>Custom</strong> to set a date
        yourself.
      </p>

      {suggested.length > 0 && endPhase.length === 0 && (
        <div className="info-box deadlines-suggest">
          <p>
            {suggested.join(", ")} looks like end-of-project work. The plan
            schedules it as early as someone is free, so measured against the
            plan it reads as behind for most of the project. Treat it as
            end-of-project work to count it back from the end date instead.
          </p>
          <Button
            small
            onClick={() => set({ endPhase: [...endPhase, ...suggested] })}
          >
            Treat {suggested.join(", ")} as end-of-project work
          </Button>
        </div>
      )}

      <div className="deadlines-grid">
        <DateChoice
          groupId={id}
          legend="Start date"
          planValue={resolved?.planStartDate ?? project.startDate}
          planNote="the project's start date"
          custom={current.startDate}
          onChange={(v) => set({ startDate: v })}
        />
        <DateChoice
          groupId={id}
          legend="End of development"
          planValue={resolved?.planDevEndDate ?? null}
          planNote={
            endPhase.length > 0
              ? `when ${development.join(", ")} finish${development.length === 1 ? "es" : ""}`
              : "when all the work finishes"
          }
          custom={current.devEndDate}
          onChange={(v) => set({ devEndDate: v })}
        />
        <DateChoice
          groupId={id}
          legend="End date"
          planValue={resolved?.planEndDate ?? null}
          planNote="the plan's finish with buffer"
          custom={current.endDate}
          onChange={(v) => set({ endDate: v })}
        />

        <fieldset className="deadlines-choice deadlines-phase">
          <legend>Counts as development</legend>
          {specs.map((spec) => {
            const isDev = !endPhase.includes(spec);
            return (
              <label key={spec} className="deadlines-option">
                <input
                  type="checkbox"
                  checked={isDev}
                  // At least one specialization has to be development.
                  disabled={isDev && development.length === 1}
                  onChange={(e) =>
                    set({
                      endPhase: e.target.checked
                        ? endPhase.filter((s) => s !== spec)
                        : [...endPhase, spec],
                    })
                  }
                />
                {spec}
              </label>
            );
          })}
          <p className="muted field-hint">
            {endPhase.length > 0
              ? `${endPhase.join(", ")} ${endPhase.length === 1 ? "is" : "are"} end-of-project work: counted back from the end date.`
              : "Untick end-of-project work, such as QA, to measure it from the end of development to the end date."}
          </p>
        </fieldset>
      </div>
    </section>
  );
}

/**
 * One date: the plan's value, or a custom one. A top-level component, not a
 * closure in the panel, so its date input keeps focus while being edited.
 */
function DateChoice({
  groupId,
  legend,
  planValue,
  planNote,
  custom,
  onChange,
}: {
  groupId: string;
  legend: string;
  planValue: string | null;
  planNote: string;
  custom: string | undefined;
  onChange: (value: string | undefined) => void;
}) {
  const name = `${groupId}-${legend.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <fieldset className="deadlines-choice">
      <legend>{legend}</legend>
      <label className="deadlines-option">
        <input
          type="radio"
          name={name}
          checked={!custom}
          onChange={() => onChange(undefined)}
        />
        <span>
          From the plan: <strong>{planValue ?? "—"}</strong>
          <span className="muted"> · {planNote}</span>
        </span>
      </label>
      <label className="deadlines-option">
        <input
          type="radio"
          name={name}
          checked={Boolean(custom)}
          disabled={!planValue && !custom}
          onChange={() => onChange(custom ?? planValue ?? undefined)}
        />
        <span>Custom</span>
      </label>
      <input
        type="date"
        aria-label={`${legend}, custom`}
        value={custom ?? planValue ?? ""}
        disabled={!custom}
        onChange={(e) => onChange(e.target.value || undefined)}
      />
    </fieldset>
  );
}
