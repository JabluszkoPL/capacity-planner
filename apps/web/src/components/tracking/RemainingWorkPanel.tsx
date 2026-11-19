import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  addDays,
  diffDays,
  fromISO,
  mergedOffDays,
  personRows,
  remainingWork,
  type ForecastItem,
  type ForecastPerson,
  type Project,
  type Team,
  type Tracker,
  type TrackerStatus,
  type RemainingWork,
} from "@planner/core";
import {
  DateGrid,
  GanttBar,
  type GanttRange,
  type GanttRow,
} from "../schedule/DateGrid";
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

/** Width of the person column in the timeline. */
const LABEL_WIDTH = 130;
/** Day widths the zoom buttons step through, in pixels. */
const ZOOM_STEPS = [12, 18, 24, 32, 44, 60, 80, 110];
/** Fit never squeezes a day narrower than this; the chart scrolls instead. */
const MIN_FIT = 12;
/** Columns at least this wide get a label for every day. */
const DAY_LABELS_FROM = 22;

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
  if (!item.inPlan) {
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

/** Today to a couple of days past the last finish: no empty weeks after it. */
function forecastRange(from: string, finish: string): GanttRange {
  const rangeStart = fromISO(from);
  const totalDays = Math.max(diffDays(rangeStart, fromISO(finish)) + 3, 10);
  return {
    rangeStart,
    rangeEnd: finish,
    totalDays,
    dates: Array.from({ length: totalDays }, (_, i) => addDays(rangeStart, i)),
    todayIndex: 0,
  };
}

/** The width of an element, kept current as the window resizes. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
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
      const extra = sum(
        mine.filter((a) => !a.inPlan),
        (a) => a.estimateDays,
      );
      const fromJira = sum(
        mine.filter((a) => a.inPlan && a.estimateFrom === "jira"),
        (a) => a.estimateDays,
      );
      const shorter = sum(
        mine.filter((a) => a.inProgress),
        (a) => a.plannedDays - a.estimateDays,
      );
      const reasons: string[] = [];
      if (extra > 0.05) {
        reasons.push(
          `+${days(extra)} d of Jira tasks not in the plan, which the status leaves out until they are marked as added scope`,
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
  const work = useMemo(
    () => remainingWork(tracker, project, teams, today, { countWaiting }),
    [tracker, project, teams, today, countWaiting],
  );
  const offDays = useMemo(() => mergedOffDays(teams), [teams]);
  // "fit" spreads the days over the width; a number is a fixed day width.
  const [zoom, setZoom] = useState<"fit" | number>("fit");
  const [chartRef, chartWidth] = useWidth();
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

  const range =
    work.items.length > 0 && work.finish
      ? forecastRange(work.from, work.finish)
      : null;
  const fitWidth = range
    ? Math.max(
        MIN_FIT,
        Math.floor((chartWidth - LABEL_WIDTH - 4) / range.totalDays),
      )
    : MIN_FIT;
  const colWidth = zoom === "fit" ? fitWidth : zoom;
  const zoomIn = ZOOM_STEPS.find((w) => w > colWidth);
  const zoomOut = [...ZOOM_STEPS].reverse().find((w) => w < colWidth);

  // Lanes in the table's order: whoever finishes last on top.
  const order = new Map(work.people.map((p, i) => [p.memberId, i]));
  const lanes = personRows(work.items, offDays).sort(
    (a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0),
  );
  const byTask = new Map(work.items.map((a) => [a.taskId, a]));
  const rows: GanttRow[] = range
    ? lanes.map((lane) => {
        const index = order.get(lane.key) ?? 0;
        const person = work.people[index];
        const previous = lanes[lanes.indexOf(lane) - 1];
        const previousPerson = previous
          ? work.people[order.get(previous.key) ?? 0]
          : undefined;
        return {
          key: lane.key,
          className:
            previousPerson &&
            specKey(previousPerson.specialization) !==
              specKey(person.specialization)
              ? "group-start"
              : undefined,
          labelBorderColor: lane.borderColor,
          offDays: lane.offDays,
          label: (
            <span className="lbl-title" title={`done by ${person.finish}`}>
              {lane.title}
            </span>
          ),
          bars: lane.bars.map((bar) => {
            const item = byTask.get(bar.taskId);
            const started = item?.inProgress ?? false;
            const keys = item?.jiraKeys.join(", ");
            const how =
              item?.assignedBy === "planner"
                ? "suggested by the planner"
                : "assigned in Jira";
            return (
              <GanttBar
                key={bar.taskId}
                bar={bar}
                rangeStart={range.rangeStart}
                colWidth={colWidth}
                className={
                  item?.assignedBy === "planner" ? "suggested" : undefined
                }
                label={
                  (started ? "▶ " : item?.waiting ? "⏸ " : "") + bar.taskName
                }
                title={`${keys ? keys + " " : ""}${bar.taskName} (${bar.epicName})\n${bar.memberName} · ${bar.start} → ${bar.end} · ${days(bar.estimateDays)} d${started ? " left · in progress" : ""}${item?.waiting ? " · waiting to be closed, counted at its whole estimate" : ""}\n${how}${item && !item.inPlan ? " · not in the plan, Jira's estimate" : ""}`}
              />
            );
          }),
        };
      })
    : [];

  return (
    <section className="remaining-work" aria-labelledby="remaining-work-title">
      <h2 id="remaining-work-title" className="section-title">
        Work left, by person
      </h2>
      {work.items.length === 0 ? (
        <p className="muted">No estimated work left to plan.</p>
      ) : (
        <p>
          {plural(work.items.length, "estimated task")} still open (
          {days(planned)} plan days), laid out from today without buffer.{" "}
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
        stays with whoever has it, for what Jira says is left of it, and a task
        assigned in Jira waits for its assignee.
        {work.countWaiting &&
          work.waitingToClose.tasks > 0 &&
          ` ${plural(work.waitingToClose.tasks, "task")} waiting to be closed (⏸, ${days(work.waitingToClose.days)} d) ${work.waitingToClose.tasks === 1 ? "still counts" : "still count"} as work at ${work.waitingToClose.tasks === 1 ? "its" : "their"} whole estimate, as in the status.`}
        {leftOut.length > 0 && ` Left out: ${leftOut.join(" · ")}.`}
      </p>
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
      <Comparison rows={comparison} />

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

      <div className="forecast-gantt" ref={chartRef}>
        {range && (
          <>
            <div className="forecast-toolbar">
              <span className="muted">
                <span className="forecast-swatch" /> assigned in Jira{" "}
                <span className="forecast-swatch suggested" /> suggested
              </span>
              <div className="seg-toggle" role="group" aria-label="Zoom">
                <button
                  type="button"
                  className="seg-btn"
                  onClick={() => zoomOut && setZoom(zoomOut)}
                  disabled={!zoomOut}
                  aria-label="Zoom out"
                >
                  −
                </button>
                <button
                  type="button"
                  className={"seg-btn" + (zoom === "fit" ? " active" : "")}
                  aria-pressed={zoom === "fit"}
                  onClick={() => setZoom("fit")}
                >
                  Fit to width
                </button>
                <button
                  type="button"
                  className="seg-btn"
                  onClick={() => zoomIn && setZoom(zoomIn)}
                  disabled={!zoomIn}
                  aria-label="Zoom in"
                >
                  +
                </button>
              </div>
            </div>
            <DateGrid
              range={range}
              colWidth={colWidth}
              labelWidth={LABEL_WIDTH}
              dayLabels={colWidth >= DAY_LABELS_FROM}
              rows={rows}
            />
          </>
        )}
      </div>
    </section>
  );
}
