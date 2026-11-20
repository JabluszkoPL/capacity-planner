import { Fragment, useMemo, useState } from "react";
import {
  remainingWork,
  type ForecastItem,
  type ForecastPerson,
  type Project,
  type Team,
  type Tracker,
  type TrackerStatus,
  type RemainingWork,
} from "@planner/core";
import { ForecastTimeline } from "./ForecastTimeline";
import { days } from "./StatusPanel";
import "../schedule/schedule.css";

interface RemainingWorkPanelProps {
  tracker: Tracker;
  project: Project;
  teams: Team[];
  today: string;
  /** The tracker's status, to set this forecast's dates beside its own. */
  status?: TrackerStatus;
}

function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}

/** People of one specialization, in the forecast's order. */
interface PeopleGroup {
  key: string;
  specialization: string;
  people: ForecastPerson[];
  finish: string | null;
}

/** Runs of the same specialization; the forecast already keeps them together. */
function groupBySpecialization(people: ForecastPerson[]): PeopleGroup[] {
  const groups: PeopleGroup[] = [];
  for (const p of people) {
    const key = p.specialization.trim().toLowerCase();
    let g = groups.at(-1);
    if (!g || g.key !== key) {
      g = { key, specialization: p.specialization, people: [], finish: null };
      groups.push(g);
    }
    g.people.push(p);
    if (p.finish && (!g.finish || p.finish > g.finish)) g.finish = p.finish;
  }
  return groups;
}

/** "J-12 Login form", linked to Jira when the task maps to an issue. */
function TaskRef({ item, baseUrl }: { item: ForecastItem; baseUrl: string }) {
  const key = item.jiraKeys[0];
  return (
    <>
      {key && (
        <>
          <a href={`${baseUrl}/browse/${key}`} target="_blank" rel="noreferrer">
            {key}
          </a>{" "}
        </>
      )}
      {item.taskName}
    </>
  );
}

/** Who decided this person takes it, plus "not in the plan" when so. */
function Tags({ item }: { item: ForecastItem }) {
  const tags: { text: string; className: string }[] = [];
  if (item.waiting) {
    tags.push({ text: "waiting to be closed", className: "forecast-tag" });
  }
  tags.push(
    item.assignedBy === "planner"
      ? { text: "suggested", className: "forecast-tag suggested" }
      : { text: "assigned in Jira", className: "forecast-tag" },
  );
  if (item.niceToHave) {
    tags.push({ text: "nice to have", className: "forecast-tag nice" });
  } else if (!item.inPlan) {
    tags.push({ text: "not in the plan", className: "forecast-tag extra" });
  }
  return (
    <>
      {tags.map((t) => (
        <span key={t.text}>
          {" "}
          <span className={t.className}>{t.text}</span>
        </span>
      ))}
    </>
  );
}

function Now({ person, baseUrl }: { person: ForecastPerson; baseUrl: string }) {
  if (person.current.length === 0 && person.unestimated.length === 0) {
    return <span className="muted">—</span>;
  }
  return (
    <>
      {person.current.map((item) => (
        <div key={item.taskId}>
          <TaskRef item={item} baseUrl={baseUrl} />
          <span className="muted"> · until {item.end}</span>
        </div>
      ))}
      {person.unestimated.map((u) => (
        <div key={u.key ?? u.name}>
          {u.key && (
            <>
              <a
                href={`${baseUrl}/browse/${u.key}`}
                target="_blank"
                rel="noreferrer"
              >
                {u.key}
              </a>{" "}
            </>
          )}
          {u.name}
          <span className="muted"> · no estimate, so not on the timeline</span>
        </div>
      ))}
    </>
  );
}

/** "J-1, J-2, J-3 and 4 more", for naming the tasks a line is about. */
function keyList(keys: string[], max = 6): string {
  if (keys.length <= max) return keys.join(", ");
  return `${keys.slice(0, max).join(", ")} and ${keys.length - max} more`;
}

function Next({
  person,
  baseUrl,
}: {
  person: ForecastPerson;
  baseUrl: string;
}) {
  const next = person.next;
  if (!next) {
    return (
      <span className="muted">
        {person.tasks === 0 ? "nothing planned for them" : "nothing after it"}
      </span>
    );
  }
  return (
    <>
      <TaskRef item={next} baseUrl={baseUrl} />
      <Tags item={next} />
      <div className="muted">
        {days(next.estimateDays)} d · {next.start} → {next.end}
        {next.assignedBy === "planner" && next.jiraAssignee
          ? ` · Jira has it on ${next.jiraAssignee}, who isn't on the plan`
          : ""}
      </div>
    </>
  );
}

const specKey = (s: string) => s.trim().toLowerCase();

/** One specialization's finish here and in the status, and why they differ. */
interface SpecComparison {
  specialization: string;
  endPhase: boolean;
  forecast: string | null;
  status: string | null;
  reasons: string[];
}

/**
 * Every specialization the status reads, with this forecast's finish beside
 * the status's projected finish and what accounts for the gap: the work one
 * counts that the other doesn't, and how each lays it out.
 */
export function compareWithStatus(
  work: RemainingWork,
  status: TrackerStatus,
): SpecComparison[] {
  const endPhase = new Set(
    (status.deadlines?.endPhase ?? []).map((s) => specKey(s)),
  );
  return status.bySpecialization
    .filter((r) => r.projectedFinish !== null || r.phase)
    .map((r) => {
      const key = specKey(r.specialization);
      const mine = work.items.filter((a) => specKey(a.specialization) === key);
      const forecast = mine.reduce<string | null>(
        (max, a) => (max === null || a.end > max ? a.end : max),
        null,
      );
      const sum = (list: ForecastItem[], f: (a: ForecastItem) => number) =>
        list.reduce((n, a) => n + f(a), 0);
      // Nice-to-have work is never in the status, whatever else it is.
      const nice = sum(
        mine.filter((a) => a.niceToHave),
        (a) => a.estimateDays,
      );
      const mustDo = mine.filter((a) => !a.niceToHave);
      const extra = sum(
        mustDo.filter((a) => !a.inPlan),
        (a) => a.estimateDays,
      );
      const fromJira = sum(
        mustDo.filter((a) => a.inPlan && a.estimateFrom === "jira"),
        (a) => a.estimateDays,
      );
      const shorter = sum(
        mine.filter((a) => a.inProgress),
        (a) => a.plannedDays - a.estimateDays,
      );
      const reasons: string[] = [];
      if (nice > 0.05) {
        reasons.push(
          `+${days(nice)} d of nice-to-have work, which the status leaves out`,
        );
      }
      if (extra > 0.05) {
        reasons.push(
          `+${days(extra)} d of Jira tasks not in the plan, which the status leaves out until they have a specialization`,
        );
      }
      if (fromJira > 0.05) {
        reasons.push(
          `+${days(fromJira)} d on Jira's estimate for tasks the plan hasn't estimated, which the status doesn't count yet`,
        );
      }
      if (shorter > 0.05) {
        reasons.push(
          `−${days(shorter)} d: Jira says less is left of work in progress, where the status counts its whole estimate until it is Done`,
        );
      }
      const waiting = work.waitingToClose.bySpecialization.find(
        (w) => specKey(w.specialization) === key,
      );
      if (!work.countWaiting && waiting) {
        reasons.push(
          `−${days(waiting.days)} d: ${plural(waiting.tasks, "task")} in review or ready to deploy ${waiting.tasks === 1 ? "isn't" : "aren't"} planned here; the status still counts ${waiting.tasks === 1 ? "it" : "them"} until Done (its "closed today" figure leaves ${waiting.tasks === 1 ? "it" : "them"} out too)`,
        );
      }
      const isEndPhase = Boolean(r.phase) || endPhase.has(key);
      if (isEndPhase) {
        reasons.push(
          "the status counts end-phase work back from the end date; here it starts as soon as someone is free",
        );
      } else if (forecast !== r.projectedFinish) {
        reasons.push(
          "laid out task by task here, one person on each; the status follows the plan's pace or shares the work evenly across its people",
        );
      }
      return {
        specialization: r.specialization,
        endPhase: isEndPhase,
        forecast,
        status: r.projectedFinish,
        reasons,
      };
    });
}

/** The forecast's finish per specialization beside the status's. */
function Comparison({ rows }: { rows: SpecComparison[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="table-scroll">
      <table className="history-table forecast-compare">
        <caption>Compared with the status above</caption>
        <thead>
          <tr>
            <th scope="col">Specialization</th>
            <th scope="col">Done by here</th>
            <th scope="col">Projected finish in the status</th>
            <th scope="col">Why they differ</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.specialization}>
              <th scope="row">
                {r.specialization}
                {r.endPhase ? " · end phase" : ""}
              </th>
              <td>{r.forecast ?? "—"}</td>
              <td>{r.status ?? "—"}</td>
              <td>
                {r.forecast === r.status ? (
                  <span className="muted">same</span>
                ) : (
                  <ul className="forecast-reasons">
                    {r.reasons.map((why) => (
                      <li key={why}>{why}</li>
                    ))}
                  </ul>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The work left, laid out from today: who picks up which task next and when
 * each person runs out of work. See `remainingWork` in core for what is
 * planned, what is left out and why.
 */
export function RemainingWorkPanel({
  tracker,
  project,
  teams,
  today,
  status,
}: RemainingWorkPanelProps) {
  // Only To Do and In Progress by default: nobody needs to pick up work in
  // review. Ticking the box plans it too, as the status counts it.
  const [countWaiting, setCountWaiting] = useState(false);
  // Must-do work only by default, as the status reads it; ticking the box
  // lays out the nice-to-have epics on top.
  const [includeNiceToHave, setIncludeNiceToHave] = useState(false);
  const hasNiceToHave = (tracker.niceToHaveEpics ?? []).length > 0;
  // Left out by default, since nobody has said how long they take; ticking
  // the box plans each at the days typed beside it, to see roughly where
  // they land.
  const [assumeEstimate, setAssumeEstimate] = useState(false);
  const [assumedDays, setAssumedDays] = useState(1);
  const unestimatedDays =
    assumeEstimate && assumedDays > 0 ? assumedDays : undefined;
  const work = useMemo(
    () =>
      remainingWork(tracker, project, teams, today, {
        countWaiting,
        includeNiceToHave,
        unestimatedDays,
      }),
    [
      tracker,
      project,
      teams,
      today,
      countWaiting,
      includeNiceToHave,
      unestimatedDays,
    ],
  );
  if (!work) return null;

  const planned = work.items.reduce((sum, a) => sum + a.estimateDays, 0);
  const suggested = work.items.filter((a) => a.assignedBy === "planner");
  const notInPlan = work.items.filter((a) => !a.inPlan);
  const last = work.people.filter(
    (p) => p.finish !== null && p.finish === work.finish,
  );
  const comparison = status ? compareWithStatus(work, status) : [];
  const groups = groupBySpecialization(work.people);
  const endPhase = new Set(
    comparison.filter((r) => r.endPhase).map((r) => specKey(r.specialization)),
  );
  const latest = (list: ForecastItem[]) =>
    list.reduce<string | null>(
      (max, a) => (max === null || a.end > max ? a.end : max),
      null,
    );
  const devFinish = latest(
    work.items.filter((a) => !endPhase.has(specKey(a.specialization))),
  );
  const endFinish = latest(
    work.items.filter((a) => endPhase.has(specKey(a.specialization))),
  );
  const leftOut = [
    !work.countWaiting &&
      work.waitingToClose.tasks > 0 &&
      `${plural(work.waitingToClose.tasks, "task")} in review or ready to deploy (${days(work.waitingToClose.days)} d)`,
    work.unestimated > 0 &&
      `${plural(work.unestimated, "task")} without an estimate${
        work.unestimatedTasks.some((u) => u.key)
          ? ` (${keyList(
              work.unestimatedTasks
                .filter((u) => u.key)
                .map((u) => (u.inProgress ? `${u.key} in progress` : u.key!)),
            )})`
          : ""
      }`,
    work.unassigned.length > 0 &&
      `${plural(work.unassigned.length, "task")} nobody on the plan can do`,
    work.noSpecialization.length > 0 &&
      `${plural(work.noSpecialization.length, "Jira task")} not in the plan with no way to tell whose work it is (${work.noSpecialization.map((t) => t.key).join(", ")}) — give it a label naming a specialization, or an assignee`,
  ].filter(Boolean);

  // Beside the chart, so a change shows on it at once.
  // Always offered, so it is there to find even when nothing needs it yet.
  const options = (
    <>
      {work.waitingToClose.tasks > 0 && (
        <label className="forecast-option">
          <input
            type="checkbox"
            checked={countWaiting}
            onChange={(e) => setCountWaiting(e.target.checked)}
          />{" "}
          Also plan tasks in review or ready to deploy (as the status counts
          them)
        </label>
      )}
      {hasNiceToHave && (
        <label className="forecast-option">
          <input
            type="checkbox"
            checked={includeNiceToHave}
            onChange={(e) => setIncludeNiceToHave(e.target.checked)}
          />{" "}
          Also plan nice-to-have work (on top of the plan; the status leaves it
          out)
        </label>
      )}
      <span className="forecast-option">
        <label className="forecast-option-inline">
          <input
            type="checkbox"
            checked={assumeEstimate}
            onChange={(e) => setAssumeEstimate(e.target.checked)}
          />{" "}
          Also plan tasks with no estimate, at
        </label>
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
        {work.unestimated === 0 && work.assumed === 0 && (
          <span className="muted"> (none right now)</span>
        )}
      </span>
    </>
  );

  // Not on the chart, so it can only run later than drawn: said beside it.
  const unestimatedKeys = work.unestimatedTasks
    .map((u) => u.key)
    .filter((k): k is string => !!k);
  const unestimatedNote =
    work.assumed > 0
      ? `${plural(work.assumed, "task")} with no estimate ${work.assumed === 1 ? "is" : "are"} planned at ${days(assumedDays)} d each (dotted outline), so the real finish may differ.`
      : work.unestimated > 0
        ? `${plural(work.unestimated, "task")} ${work.unestimated === 1 ? "has" : "have"} no estimate${
            unestimatedKeys.length > 0 ? ` (${keyList(unestimatedKeys)})` : ""
          } and ${work.unestimated === 1 ? "is" : "are"} not on the chart, so the work may take longer than shown.`
        : null;

  return (
    <section className="remaining-work" aria-labelledby="remaining-work-title">
      <h2 id="remaining-work-title" className="section-title">
        Work left, by person
      </h2>
      {work.items.length === 0 ? (
        <p className="muted">No estimated work left to plan.</p>
      ) : (
        <p>
          {plural(
            work.items.length,
            work.assumed > 0 ? "task" : "estimated task",
          )}{" "}
          still open ({days(planned)} plan days), laid out from today without
          buffer.{" "}
          {endFinish && devFinish ? (
            <>
              Development is done by <strong>{devFinish}</strong>, end-phase
              work by <strong>{endFinish}</strong>
            </>
          ) : (
            <>
              All of it is done by <strong>{work.finish}</strong>
            </>
          )}
          {last.length > 0 && (
            <>
              ; {last.map((p) => p.name).join(", ")}{" "}
              {last.length === 1 ? "finishes" : "finish"} last
            </>
          )}
          .
          {suggested.length > 0 &&
            ` ${plural(suggested.length, "task")} nobody holds in Jira ${suggested.length === 1 ? "is" : "are"} given to whoever is free first (marked suggested).`}
          {notInPlan.length > 0 &&
            ` ${plural(notInPlan.length, "Jira task")} not in the plan ${notInPlan.length === 1 ? "is" : "are"} included on Jira's estimate.`}
        </p>
      )}
      <p className="muted">
        Only tasks in To Do or In Progress are planned. Work in progress (▶)
        stays with whoever has it, for what Jira says is left of it. Of the
        rest, what Jira already has on someone goes to them first, then the rest
        by Jira priority: low-priority work comes last.
        {work.countWaiting &&
          work.waitingToClose.tasks > 0 &&
          ` ${plural(work.waitingToClose.tasks, "task")} waiting to be closed (⏸, ${days(work.waitingToClose.days)} d) ${work.waitingToClose.tasks === 1 ? "still counts" : "still count"} as work at ${work.waitingToClose.tasks === 1 ? "its" : "their"} whole estimate, as in the status.`}
        {leftOut.length > 0 && ` Left out: ${leftOut.join(" · ")}.`}
      </p>
      <Comparison rows={comparison} />

      <ForecastTimeline
        work={work}
        teams={teams}
        controls={options}
        note={unestimatedNote}
      />

      <div className="table-scroll">
        <table className="history-table forecast-table">
          <thead>
            <tr>
              <th scope="col">Person</th>
              <th scope="col">Now</th>
              <th scope="col">Next up</th>
              <th scope="col" className="num">
                Left
              </th>
              <th scope="col">Done by</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <Fragment key={g.key}>
                <tr className="forecast-group">
                  <th scope="colgroup" colSpan={5}>
                    {g.specialization || "No specialization"}
                    <span className="muted">
                      {" "}
                      · {plural(g.people.length, "person", "people")}
                      {g.finish
                        ? ` · done by ${g.finish}`
                        : " · nothing planned"}
                    </span>
                  </th>
                </tr>
                {g.people.map((p) => (
                  <tr key={p.memberId}>
                    <th scope="row">{p.name}</th>
                    <td>
                      <Now person={p} baseUrl={tracker.baseUrl} />
                    </td>
                    <td>
                      <Next person={p} baseUrl={tracker.baseUrl} />
                    </td>
                    <td className="num">
                      {p.tasks > 0
                        ? `${plural(p.tasks, "task")} · ${days(p.days)} d`
                        : "—"}
                    </td>
                    <td>
                      {p.finish ?? <span className="muted">free now</span>}
                    </td>
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
