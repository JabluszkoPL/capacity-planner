import { useId, useMemo, useState } from "react";
import {
  addDays,
  fromISO,
  remainingWork,
  sprintWorkdays,
  sprintsFor,
  toISO,
  type PlanMarker,
  type Project,
  type Team,
  type Tracker,
} from "@planner/core";
import { Button } from "../ui/Button";
import { ForecastTimeline } from "./ForecastTimeline";
import { days } from "./StatusPanel";

interface AutoSprintPlannerProps {
  tracker: Tracker;
  project: Project;
  teams: Team[];
  today: string;
}

/** The settings a plan was made with: the form can change after Plan. */
interface SprintSettings {
  start: string;
  weeks: number;
  /** Days each person counts per sprint. */
  perPerson: number;
  /** Plan days for each task with no estimate; 0 leaves them out. */
  unestimatedDays: number;
}

const WEEK_CHOICES = [1, 2, 3, 4];
/** Of a sprint's working days, the share counted by default. */
const DEFAULT_FOCUS = 0.8;

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Today when it is a Monday, else the next Monday. */
export function nextMonday(today: string): string {
  const d = fromISO(today);
  const ahead = (8 - d.getDay()) % 7;
  return toISO(addDays(d, ahead));
}

/**
 * Cuts the work left into sprints: pick when the first starts, how long they
 * are and how many days each person counts per sprint, press Plan, and see
 * the sprints on a timeline with when each ends.
 *
 * The planning is the work-left forecast (`remainingWork` in core) started on
 * the sprint start, at the share of each working day those days come to;
 * `sprintsFor` only lays the sprints over its dates.
 */
export function AutoSprintPlanner({
  tracker,
  project,
  teams,
  today,
}: AutoSprintPlannerProps) {
  const id = useId();
  const [form, setForm] = useState<SprintSettings>(() => ({
    start: nextMonday(today),
    weeks: 2,
    perPerson: Math.round(sprintWorkdays(2) * DEFAULT_FOCUS),
    unestimatedDays: 0,
  }));
  const [assume, setAssume] = useState(false);
  const [assumedDays, setAssumedDays] = useState(1);
  const [planned, setPlanned] = useState<SprintSettings | null>(null);

  const workdays = sprintWorkdays(form.weeks);
  const valid =
    /^\d{4}-\d{2}-\d{2}$/.test(form.start) &&
    form.perPerson > 0 &&
    form.perPerson <= workdays;

  const result = useMemo(() => {
    if (!planned) return null;
    const work = remainingWork(tracker, project, teams, planned.start, {
      unestimatedDays: planned.unestimatedDays || undefined,
      capacity: planned.perPerson / sprintWorkdays(planned.weeks),
    });
    if (!work) return null;
    return { work, sprints: sprintsFor(work, planned.start, planned.weeks) };
  }, [planned, tracker, project, teams]);

  const markers: PlanMarker[] =
    result?.sprints.sprints.map((s) => ({
      id: `sprint-${s.number}`,
      name: `Sprint ${s.number}`,
      date: s.start,
    })) ?? [];
  const last = result?.sprints.sprints.at(-1);

  return (
    <section
      className="panel tracking-panel sprint-auto"
      aria-labelledby={`${id}-title`}
    >
      <h2 id={`${id}-title`} className="panel-title">
        Plan sprints automatically
      </h2>
      <p className="muted">
        Lays the work left out sprint by sprint, the same way as{" "}
        <strong>Work left, by person</strong>: Jira's assignees first, low
        priority last, everyone's days off counted.
      </p>
      <form
        className="sprint-auto-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          setPlanned({
            ...form,
            unestimatedDays: assume && assumedDays > 0 ? assumedDays : 0,
          });
        }}
      >
        <label>
          <span>First sprint starts</span>
          <input
            type="date"
            value={form.start}
            required
            onChange={(e) => setForm({ ...form, start: e.target.value })}
          />
        </label>
        <label>
          <span>Sprint length</span>
          <select
            value={form.weeks}
            onChange={(e) => {
              const weeks = Number(e.target.value);
              setForm({
                ...form,
                weeks,
                perPerson: Math.min(form.perPerson, sprintWorkdays(weeks)),
              });
            }}
          >
            {WEEK_CHOICES.map((w) => (
              <option key={w} value={w}>
                {plural(w, "week")}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Days per person per sprint</span>
          <input
            type="number"
            min={0.5}
            max={workdays}
            step={0.5}
            value={form.perPerson}
            onChange={(e) =>
              setForm({ ...form, perPerson: Number(e.target.value) })
            }
          />
          <span className="muted"> of {workdays}</span>
        </label>
        <span className="sprint-auto-unestimated">
          <label>
            <input
              type="checkbox"
              checked={assume}
              onChange={(e) => setAssume(e.target.checked)}
            />{" "}
            Also plan tasks with no estimate, at
          </label>{" "}
          <input
            type="number"
            className="forecast-days-input"
            aria-label="Days for each task with no estimate"
            min={0.5}
            step={0.5}
            value={assumedDays}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v > 0) setAssumedDays(v);
            }}
          />{" "}
          d each
        </span>
        <Button type="submit" variant="primary" disabled={!valid}>
          Plan sprints
        </Button>
      </form>
      {!valid && (
        <p className="muted" role="alert">
          Pick a start date, and between 0.5 and {workdays} days per person.
        </p>
      )}

      {planned && !result && (
        <p className="muted">
          Refresh from Jira first: there is nothing to plan.
        </p>
      )}
      {planned && result && last && (
        <>
          <p className="sprint-auto-summary" role="status">
            {result.work.items.length === 0 ? (
              "No estimated work left to plan."
            ) : (
              <>
                <strong>
                  {plural(result.sprints.sprints.length, "sprint")}
                </strong>
                : the last ends <strong>{last.end}</strong>, and all the work is
                done by <strong>{result.sprints.finish}</strong>. Each person
                counts {days(planned.perPerson)} of{" "}
                {sprintWorkdays(planned.weeks)} days per sprint.
              </>
            )}
          </p>
          <div className="table-scroll">
            <table className="history-table sprint-auto-table">
              <thead>
                <tr>
                  <th scope="col">Sprint</th>
                  <th scope="col">From</th>
                  <th scope="col">To</th>
                  <th scope="col" className="num">
                    Tasks done
                  </th>
                  <th scope="col" className="num">
                    Plan days
                  </th>
                </tr>
              </thead>
              <tbody>
                {result.sprints.sprints.map((s) => (
                  <tr key={s.number}>
                    <th scope="row">Sprint {s.number}</th>
                    <td>{s.start}</td>
                    <td>{s.end}</td>
                    <td className="num">{s.items.length}</td>
                    <td className="num">{days(s.days)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ForecastTimeline
            work={result.work}
            teams={teams}
            markers={markers}
            note={
              result.work.unestimated > 0
                ? `${plural(result.work.unestimated, "task")} with no estimate ${result.work.unestimated === 1 ? "is" : "are"} not planned, so the sprints may run longer.`
                : result.work.assumed > 0
                  ? `${plural(result.work.assumed, "task")} with no estimate ${result.work.assumed === 1 ? "is" : "are"} planned at ${days(planned.unestimatedDays)} d each (dotted outline).`
                  : undefined
            }
          />
        </>
      )}
    </section>
  );
}
