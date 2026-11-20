import type {
  AwaitingCloseWhatIf,
  SpecializationStatus,
  TrackerStatus,
} from "@planner/core";
import type { ReactNode } from "react";
import { Badge, Callout, Panel, StatRow, StatTile, type Tone } from "../ui";
import { Icon } from "../ui/Icon";
import {
  SpecChartView,
  SpecViewSwitch,
  useSpecView,
} from "./SpecializationViews";

/** One decimal, trailing ".0" dropped — the plan's own number formatting. */
export function days(n: number): string {
  return Number(n.toFixed(1)).toString();
}

/** What the headline is judged against, in words: "end of development" or "end date". */
export function deadlineName(s: TrackerStatus): string {
  return s.deadlineKind === "dev-end" ? "end of development" : "end date";
}

function deadlineLabel(s: TrackerStatus): string {
  return s.deadlineKind === "dev-end" ? "Development ends" : "End date";
}

/**
 * Status as a word, a glyph and a colour.
 *
 * Colour is never the only carrier: the label says the same thing in text and
 * the glyph repeats it again, so the panel reads correctly in greyscale and to
 * a screen reader (docs/ACCESSIBILITY.md).
 *
 * Every headline names the date it is measured against, because two are in
 * play: progress is measured against the **finish without buffer**, and the
 * slack after it runs to the **deadline** — the end of development when one is
 * set, otherwise the end date. "Ahead by 27 days" alone reads as ahead of the
 * end date, which it is not.
 */
export function statusLabel(s: TrackerStatus): {
  text: string;
  glyph: string;
  tone: string;
  /** Where things stand against the deadline; absent without a baseline. */
  endDate?: string;
} {
  const endDate = endDateLine(s);
  switch (s.kind) {
    case "ahead":
      return {
        text: `${plural(s.varianceDays, "day")} ahead of the finish without buffer`,
        glyph: "▲",
        tone: "ok",
        endDate,
      };
    case "on-plan":
      return {
        text: "On time for the finish without buffer",
        glyph: "●",
        tone: "info",
        endDate,
      };
    case "using-buffer": {
      const pct =
        s.bufferDays > 0
          ? Math.round((s.bufferUsedDays / s.bufferDays) * 100)
          : 0;
      return {
        text:
          `${plural(-s.varianceDays, "day")} behind the finish without buffer · ` +
          `using ${days(s.bufferUsedDays)} of ${plural(s.bufferDays, "buffer day")} (${pct}%)`,
        glyph: "▼",
        tone: "warn",
        endDate,
      };
    }
    case "over-buffer": {
      const late = `${plural(s.overrunDays, "day")} late for the ${deadlineName(s)}`;
      return {
        text:
          s.bufferDays > 0 && s.varianceDays < 0
            ? `Buffer used up · ${late}`
            : late[0].toUpperCase() + late.slice(1),
        glyph: "■",
        tone: "bad",
        endDate,
      };
    }
    default:
      return { text: "Not comparable yet", glyph: "○", tone: "muted" };
  }
}

/** "End date 2026-12-25 · 35 days to spare", or how late it lands. */
function endDateLine(s: TrackerStatus): string | undefined {
  const date = s.deadline ?? s.bufferedEnd;
  if (s.kind === "no-baseline" || !date) return undefined;
  const label = deadlineLabel(s);
  const margin = s.marginDays;
  if (margin === null) return `${label} ${date}`;
  if (margin >= 0.5) {
    return `${label} ${date} · ${plural(margin, "day")} to spare`;
  }
  if (margin > -0.5) return `${label} ${date} · on time, no days to spare`;
  return `${label} ${date} · projected ${plural(-margin, "day")} late (${s.projectedFinish})`;
}

function plural(n: number, word: string): string {
  return `${days(n)} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * The reading as one short word for a pill ("Using buffer", "Late"), with the
 * tone it is drawn in. Always shown beside the full sentence, never instead.
 */
export function statusBadge(s: TrackerStatus): { word: string; tone: Tone } {
  switch (s.kind) {
    case "ahead":
      return { word: "Ahead", tone: "success" };
    case "on-plan":
      return { word: "On track", tone: "success" };
    case "using-buffer":
      return { word: "Using buffer", tone: "warning" };
    case "over-buffer":
      return { word: "Late", tone: "danger" };
    default:
      return { word: "No baseline", tone: "neutral" };
  }
}

/** The same for one specialization's row. */
export function specializationBadge(r: SpecializationStatus): {
  word: string;
  tone: Tone;
} {
  switch (r.kind) {
    case "ahead":
      return { word: "Ahead", tone: "success" };
    case "on-plan":
      return { word: "On time", tone: "success" };
    case "behind":
      return { word: "Behind", tone: "warning" };
    case "late":
      return { word: "Late", tone: "danger" };
    case "not-started":
      return { word: "Not started", tone: "neutral" };
    case "done":
      return { word: "Done", tone: "success" };
    case "no-estimate":
      return { word: "No estimates yet", tone: "neutral" };
    default:
      return { word: "No one", tone: "danger" };
  }
}

/**
 * A specialization's verdict: the pill, then the sentence when it says more
 * than the pill does. The glyph rides in the pill, so colour is never alone.
 */
export function SpecVerdict({
  r,
  deadline,
  className,
}: {
  r: SpecializationStatus;
  deadline?: string;
  className?: string;
}) {
  const label = specializationLabel(r, deadline);
  const badge = specializationBadge(r);
  return (
    <span className={"spec-verdict" + (className ? " " + className : "")}>
      <Badge
        tone={badge.tone}
        icon={
          <span aria-hidden="true" className="badge-glyph">
            {label.glyph}
          </span>
        }
      >
        {badge.word}
      </Badge>
      {label.text !== badge.word && (
        <span className={"spec-verdict-text status-cell " + label.tone}>
          {label.text}
        </span>
      )}
    </span>
  );
}

/**
 * The specialization that sets the headline, when it is worth naming: only
 * with more than one in the table, since with one the reading is plainly its.
 */
export function criticalName(s: TrackerStatus): string | null {
  return s.critical && s.bySpecialization.length > 1 ? s.critical : null;
}

/**
 * A lead this large usually means the plan is slower than reality — it starts
 * later, or has fewer people, than the work actually did — rather than the team
 * being far ahead. Worth a nudge, never a verdict.
 */
export function suspiciousLead(s: TrackerStatus): boolean {
  return (
    s.kind === "ahead" && s.earnedDays > 0 && s.earnedDays >= 2 * s.plannedDays
  );
}

/**
 * How much of a specialization's own buffer a delay spends: days used, days
 * left and the share used. Null when it has no buffer to speak of.
 */
export function specializationBuffer(
  r: SpecializationStatus,
): { used: number; left: number; total: number; pct: number } | null {
  const total = r.bufferDays ?? 0;
  if (total <= 0) return null;
  const late = r.marginDays !== null && r.marginDays < -0.5;
  const used = late
    ? total
    : Math.min(total, Math.max(0, round1(-r.varianceDays)));
  return {
    used,
    left: round1(total - used),
    total,
    pct: Math.round((used / total) * 100),
  };
}

function round1(n: number): number {
  return Number(n.toFixed(1));
}

/**
 * One specialization's reading in words, with the same glyphs and tones.
 *
 * Each tone says one thing: green how far ahead of the plan without buffer it
 * is, orange how much of its own buffer it is spending and how much is left,
 * red how late it lands after its deadline. A row that is late is not "25 days
 * behind" — most of that was its buffer, and what matters is the days after
 * the deadline.
 */
export function specializationLabel(
  r: SpecializationStatus,
  deadline = "its deadline",
): {
  text: string;
  glyph: string;
  tone: string;
} {
  const buffer = specializationBuffer(r);
  switch (r.kind) {
    case "ahead": {
      // End-phase work is measured against its buffered schedule, so its lead
      // is plain "ahead"; development's is against the plan without buffer.
      const ahead = r.phase
        ? `${plural(r.varianceDays, "day")} ahead`
        : `${plural(r.varianceDays, "day")} ahead of the plan without buffer`;
      return {
        text:
          r.phase && r.earnedDays <= 0 && r.phase.mustStartBy
            ? `${ahead} · must start by ${r.phase.mustStartBy}`
            : ahead,
        glyph: "▲",
        tone: "ok",
      };
    }
    case "on-plan":
      return {
        text: "On time",
        glyph: "●",
        tone: "info",
      };
    case "behind":
      return {
        text: buffer
          ? `Using ${days(buffer.used)} of ${plural(buffer.total, "buffer day")} (${buffer.pct}%) · ${plural(buffer.left, "day")} left`
          : `${plural(-r.varianceDays, "day")} behind`,
        glyph: "▼",
        tone: "warn",
      };
    case "late": {
      const tone = { glyph: "■", tone: "bad" };
      if (r.marginDays === null || r.marginDays > -0.5) {
        return {
          text: r.phase
            ? "Won't fit before the end date"
            : "On pace, but the plan finishes after its deadline",
          ...tone,
        };
      }
      const late = `${plural(-r.marginDays, "day")} late for ${r.phase ? "the end date" : deadline}`;
      return {
        text:
          r.varianceDays > -0.5 && !r.phase
            ? `On pace, but ${late}`
            : buffer
              ? `${late} · all ${plural(buffer.total, "buffer day")} used (100%)`
              : late,
        ...tone,
      };
    }
    case "not-started":
      return {
        text: r.firstStart
          ? `Not started yet · starts ${r.firstStart}`
          : "Not started yet",
        glyph: "○",
        tone: "muted",
      };
    case "done":
      return { text: "Done", glyph: "✓", tone: "ok" };
    case "no-estimate":
      return { text: "No estimates yet", glyph: "○", tone: "muted" };
    default:
      return {
        text: "Nobody on the plan can do this",
        glyph: "■",
        tone: "bad",
      };
  }
}

/**
 * A specialization's review queue in working days: its plan days waiting to
 * be closed, shared across its people — 3 days in review with 3 developers is
 * 1 day. Sits under the deadline reading, so the two can be read together.
 */
function QueueSummary({
  queue,
}: {
  queue?: AwaitingCloseWhatIf["bySpecialization"][number];
}) {
  if (!queue) return null;
  const who = `${queue.people} ${queue.people === 1 ? "person" : "people"}`;
  return (
    <>
      <span className="spec-detail queue-summary">
        {queue.workingDays === null
          ? `${days(queue.days)} d waiting to be closed`
          : `${plural(queue.workingDays, "day")} waiting to be closed`}
      </span>
      <span className="spec-detail muted">
        {queue.workingDays === null
          ? "nobody left to close it"
          : `${days(queue.days)} d ÷ ${who}`}
      </span>
    </>
  );
}

/** How late it lands, counted by its people (see `peopleLate` in core). */
export function peopleLateText(
  r: SpecializationStatus,
  deadline: string,
): string {
  const late = r.peopleLate!;
  if (late.days <= 0) {
    if (!late.finish) {
      return `counted by its people, the work left still fits before ${deadline}`;
    }
    // Never read as earlier than the finish without buffer: the people count
    // wins back lost time, it doesn't claim a lead.
    const early =
      !r.phase && r.unbufferedEnd && late.finish < r.unbufferedEnd
        ? `, before its finish without buffer (${r.unbufferedEnd})`
        : `, before ${deadline}`;
    return `counted by its people, the work left is done by ${late.finish}${early}`;
  }
  const who = `${late.people} ${late.people === 1 ? "person" : "people"}`;
  const rate = atSpeed(late)
    ? `, who do ${days(late.perDay)} plan days a day at their speeds`
    : "";
  return `${plural(late.overflowDays, "plan day")} won't fit before ${deadline}, split across its ${who}${rate}: ${plural(late.days, "working day")} after it`;
}

/** Their speeds don't add up to one plan day per person. */
function atSpeed(late: NonNullable<SpecializationStatus["peopleLate"]>) {
  return Math.abs(late.perDay - late.people) > 0.01;
}

/**
 * How late, as the sum it is: "11.6 d ÷ 2 people = 5.8 → 6". With speeds other
 * than 1 the daily rate is shown, since that, not the head count, is what the
 * work is divided by; a result longer than the sum is days off in between.
 */
export function peopleLateSum(
  late: NonNullable<SpecializationStatus["peopleLate"]>,
): string {
  const who = `${late.people} ${late.people === 1 ? "person" : "people"}`;
  const rate = atSpeed(late) ? ` at ${days(late.perDay)} d a day` : "";
  const exact = late.perDay > 0 ? late.overflowDays / late.perDay : 0;
  const result =
    Math.abs(exact - late.days) < 0.05
      ? `= ${days(late.days)}`
      : `= ${days(exact)} → ${days(late.days)}`;
  const off = late.days - Math.ceil(exact - 1e-9) >= 1 ? " (days off)" : "";
  return `${days(late.overflowDays)} d ÷ ${who}${rate} ${result}${off}`;
}

/** The deadline a specialization row is judged against, in words. */
export function rowDeadlineName(
  r: SpecializationStatus,
  status: TrackerStatus,
): string {
  return r.phase ? "end date" : deadlineName(status);
}

/**
 * The small print under a specialization's status: end-phase dates, how late
 * counted by people, the review queue, capacity and unestimated tasks. Shared
 * by every view of the specialization section so none of them loses a fact.
 */
export function SpecDetails({
  r,
  status,
  awaitingClose,
}: {
  r: SpecializationStatus;
  status: TrackerStatus;
  awaitingClose?: AwaitingCloseWhatIf | null;
}) {
  const queue = awaitingClose?.bySpecialization.find(
    (e) => e.specialization === r.specialization,
  );
  const closed = queue
    ? awaitingClose!.closed.bySpecialization.find(
        (e) => e.specialization === r.specialization,
      )
    : undefined;
  return (
    <>
      {r.phase && (
        <span className="spec-detail muted">
          must start by {r.phase.mustStartBy ?? "—"} with buffer ·{" "}
          {r.phase.latestStart ?? "—"} at the latest
        </span>
      )}
      {r.phase && (
        <span className="spec-detail muted">
          needs {days(r.phase.remainingDays)} of the{" "}
          {days(r.phase.capacityDays)} person-days left before the end date
        </span>
      )}
      {r.phase?.overlapsDevelopment && (
        <span className="spec-detail warn-text">
          has to start before development ends
          {status.deadlines?.devEndDate
            ? ` (${status.deadlines.devEndDate})`
            : ""}
        </span>
      )}
      {r.peopleLate && (
        <span className="spec-detail muted">
          {peopleLateText(
            r,
            r.phase ? "the end date" : `the ${deadlineName(status)}`,
          )}
        </span>
      )}
      {queue && (
        <span className="spec-detail muted">
          {queue.tasks} task{queue.tasks === 1 ? "" : "s"} ({days(queue.days)}{" "}
          d) waiting to be closed
          {closed ? ` · closed today: ${marginText(closed)}` : ""}
        </span>
      )}
      {r.capacityBound && (
        <span className="spec-detail muted">
          its people can't keep the even pace: they need {days(r.plannedDays)}{" "}
          done by today to finish the rest by {r.unbufferedEnd}
        </span>
      )}
      {r.unestimatedTasks > 0 && (
        <span className="spec-detail muted">
          {r.unestimatedTasks} task
          {r.unestimatedTasks === 1 ? "" : "s"} without an estimate — not
          counted yet
        </span>
      )}
    </>
  );
}

/** True when a row has anything for {@link SpecDetails} to say. */
export function hasSpecDetails(
  r: SpecializationStatus,
  awaitingClose?: AwaitingCloseWhatIf | null,
): boolean {
  return Boolean(
    r.phase ||
    r.peopleLate ||
    r.capacityBound ||
    r.unestimatedTasks > 0 ||
    awaitingClose?.bySpecialization.some(
      (e) => e.specialization === r.specialization,
    ),
  );
}

export function marginText(r: SpecializationStatus): string {
  if (r.marginDays === null) return r.kind === "late" ? "doesn't fit" : "—";
  if (r.marginDays >= 0.5) return `${plural(r.marginDays, "day")} to spare`;
  if (r.marginDays > -0.5) return "on time";
  return `${plural(-r.marginDays, "day")} late`;
}

/**
 * The status per specialization. The overall number adds every
 * specialization's work together; the deadline is met only if every one of
 * them meets it, so the one with the least to spare is the one to watch.
 */
function SpecializationTable({
  rows,
  status,
  awaitingClose,
  option,
}: {
  rows: SpecializationStatus[];
  status: TrackerStatus;
  awaitingClose?: AwaitingCloseWhatIf | null;
  /** Shown beside the view tabs. */
  option?: ReactNode;
}) {
  const [view, setView] = useSpecView();
  return (
    <Panel
      className="spec-status"
      aria-label="By specialization"
      title="By specialization"
      icon={<Icon name="layers" size={17} />}
    >
      <SpecViewSwitch value={view} onChange={setView}>
        {option}
      </SpecViewSwitch>
      {view === "table" ? (
        <SpecTable rows={rows} status={status} awaitingClose={awaitingClose} />
      ) : (
        <SpecChartView
          view={view}
          rows={rows}
          status={status}
          awaitingClose={awaitingClose}
        />
      )}
      {rows
        .filter((r) => r.phase && r.phase.schedule.length > 0)
        .map((r) => (
          <details key={r.specialization} className="phase-schedule">
            <summary>
              {r.specialization} schedule, counted back from the end date (
              {r.phase!.bufferDays > 0 ? "buffer included" : "no buffer"})
            </summary>
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Task</th>
                  <th scope="col">Days</th>
                  <th scope="col">Start</th>
                  <th scope="col">Finish</th>
                  <th scope="col">Done</th>
                </tr>
              </thead>
              <tbody>
                {r.phase!.schedule.map((item) => (
                  <tr key={item.taskId}>
                    <td>{item.name}</td>
                    <td className="num">{days(item.days)}</td>
                    <td>{item.start}</td>
                    <td>{item.end}</td>
                    <td>{item.done ? "Yes" : "No"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        ))}
    </Panel>
  );
}

/** The original reading: one row per specialization, every fact in words. */
function SpecTable({
  rows,
  status,
  awaitingClose,
}: {
  rows: SpecializationStatus[];
  status: TrackerStatus;
  awaitingClose?: AwaitingCloseWhatIf | null;
}) {
  return (
    <>
      <div className="table-scroll">
        <table className="data-table spec-table">
          <thead>
            <tr>
              <th scope="col">Specialization</th>
              <th scope="col">Status</th>
              <th scope="col">Done / expected by today</th>
              <th scope="col">Finish without buffer</th>
              <th scope="col">Projected finish</th>
              <th scope="col">Before its deadline</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              return (
                <tr key={r.specialization}>
                  <th scope="row">
                    {r.specialization}
                    {r.phase && <span className="muted"> · end phase</span>}
                  </th>
                  <td className="spec-status-cell">
                    <SpecVerdict
                      r={r}
                      deadline={`the ${deadlineName(status)}`}
                    />
                    <SpecDetails
                      r={r}
                      status={status}
                      awaitingClose={awaitingClose}
                    />
                  </td>
                  <td className="num">
                    {days(r.earnedDays)} / {days(r.plannedDays)} d
                    <span className="spec-detail muted">
                      of {days(r.totalDays)}
                    </span>
                  </td>
                  <td>
                    {r.phase
                      ? r.phase.mustStartBy
                        ? `starts ${r.phase.mustStartBy}, ends ${r.phase.to}`
                        : "—"
                      : (r.unbufferedEnd ?? "—")}
                  </td>
                  <td>{r.projectedFinish ?? "—"}</td>
                  <td
                    className={
                      r.kind === "late" ||
                      (r.marginDays !== null && r.marginDays <= -0.5)
                        ? "status-cell bad"
                        : undefined
                    }
                  >
                    {marginText(r)}
                    <span className="spec-detail muted">
                      {r.phase ? "end date" : deadlineName(status)}
                    </span>
                    {r.peopleLate && r.peopleLate.days > 0 && (
                      <span className="spec-detail muted">
                        {peopleLateSum(r.peopleLate)}
                      </span>
                    )}
                    <QueueSummary
                      queue={awaitingClose?.bySpecialization.find(
                        (e) => e.specialization === r.specialization,
                      )}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

/**
 * Work written but not yet closed — in review or ready — and what closing it
 * today would do to the projected finish. Only Done counts as earned, so a
 * long queue here is time the team has already spent but the reading cannot
 * see yet.
 */
export function AwaitingClose({
  status,
  whatIf,
}: {
  status: TrackerStatus;
  whatIf: AwaitingCloseWhatIf;
}) {
  const { closed } = whatIf;
  const sooner =
    status.marginDays !== null && closed.marginDays !== null
      ? closed.marginDays - status.marginDays
      : null;
  const effect =
    sooner === null || closed.kind === "no-baseline"
      ? null
      : sooner >= 0.5
        ? `projected finish ${closed.projectedFinish} instead of ${status.projectedFinish}, ${plural(sooner, "working day")} sooner. `
        : "the projected finish would not move: what is left still sets it. ";
  return (
    <Panel
      className="awaiting-close"
      tone="muted"
      title="Waiting to be closed"
      icon={<Icon name="clipboard" size={17} />}
    >
      <p>
        <strong>
          {whatIf.tasks} task{whatIf.tasks === 1 ? "" : "s"} ·{" "}
          {days(whatIf.days)} d
        </strong>{" "}
        <span className="muted">
          in review or ready, not counted as earned until Done:{" "}
          {whatIf.statuses
            .map((e) => `${e.status} ${e.tasks} (${days(e.days)} d)`)
            .join(" · ")}
        </span>
      </p>
      {effect && (
        <p>
          If they were all closed today: {effect}
          <span className="muted">{statusLabel(closed).text}.</span>
        </p>
      )}
    </Panel>
  );
}

/**
 * What a reading of some teams leaves out, so a smaller number is never
 * mistaken for the whole initiative's — and tasks with no team are found.
 */
function TeamScopeNote({
  scope,
}: {
  scope: NonNullable<TrackerStatus["teamScope"]>;
}) {
  const tasks = (n: number) => `${n} Jira task${n === 1 ? "" : "s"}`;
  const left: string[] = [];
  if (scope.otherTeamTasks > 0)
    left.push(`${tasks(scope.otherTeamTasks)} of other teams`);
  if (scope.planTasksLeftOut > 0)
    left.push(
      `${scope.planTasksLeftOut} plan task${scope.planTasksLeftOut === 1 ? "" : "s"} no Jira task of theirs maps to`,
    );
  return (
    <p className="team-scope-note">
      <strong>{scope.teamNames.join(" + ")} only.</strong>{" "}
      <span className="muted">
        Their Jira tasks, the plan work those map to, and{" "}
        {scope.peopleFrom.length > 0
          ? `the people of ${scope.peopleFrom.join(" + ")} in Planner.`
          : "everyone on the project (no Planner team has that name)."}
        {left.length > 0 && ` Left out: ${left.join("; ")}.`}
      </span>
      {scope.noTeamTasks > 0 && (
        <span className="warn-text">
          {" "}
          {tasks(scope.noTeamTasks)} with no team in Jira are left out too: set
          a team on them in Task comparison.
        </span>
      )}
    </p>
  );
}

/** The buffer as a segmented bar: used, still available, and overrun. */
function BufferMeter({ status }: { status: TrackerStatus }) {
  const { bufferDays, bufferUsedDays, overrunDays } = status;
  const total = bufferDays + overrunDays;
  if (total <= 0) return null;
  const pct = (n: number) => `${(n / total) * 100}%`;
  const usedPct =
    bufferDays > 0 ? Math.round((bufferUsedDays / bufferDays) * 100) : 100;

  return (
    <div
      className="buffer-meter"
      role="img"
      aria-label={
        overrunDays > 0
          ? `Buffer fully used, ${days(overrunDays)} days beyond it`
          : `${usedPct}% of the buffer used`
      }
    >
      <span
        className="buffer-seg used"
        style={{ width: pct(bufferUsedDays) }}
      />
      <span
        className="buffer-seg free"
        style={{ width: pct(Math.max(0, bufferDays - bufferUsedDays)) }}
      />
      {overrunDays > 0 && (
        <span className="buffer-seg over" style={{ width: pct(overrunDays) }} />
      )}
    </div>
  );
}

function PastInProgressOption({
  option,
}: {
  option: { checked: boolean; onChange: (checked: boolean) => void };
}) {
  return (
    <label className="status-option">
      <input
        type="checkbox"
        checked={option.checked}
        onChange={(e) => option.onChange(e.target.checked)}
      />{" "}
      Count tasks past To Do and In Progress as done (in review, QA, ready to
      deploy)
    </label>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="fact">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

interface StatusPanelProps {
  status: TrackerStatus;
  /** Rendered when there is no baseline — usually a link to pick one. */
  children?: ReactNode;
  /**
   * Set when the plan stored on the project no longer matches re-running it:
   * the project changed after Run Plan was last pressed. The tracker always
   * uses the re-run; this says how far the project page has drifted from it.
   */
  planStale?: { storedEnd: string | null; currentEnd: string | null };
  onOpenProject?: () => void;
  /** Tasks in review or ready, and the reading if they were closed today. */
  awaitingClose?: AwaitingCloseWhatIf | null;
  /**
   * Whether tasks past To Do and In Progress (review, QA, ready to deploy)
   * read as done. Absent when there are none, and the box is not shown.
   */
  pastInProgress?: { checked: boolean; onChange: (checked: boolean) => void };
}

export function StatusPanel({
  status,
  children,
  planStale,
  onOpenProject,
  awaitingClose,
  pastInProgress,
}: StatusPanelProps) {
  const label = statusLabel(status);
  const badge = statusBadge(status);
  const comparable = status.kind !== "no-baseline";
  // With the per-specialization views shown, the option sits beside their
  // tabs; without them it stays under the status line.
  const specTabs = comparable && status.bySpecialization.length > 1;
  const finishTone: Tone =
    status.kind === "over-buffer"
      ? "danger"
      : status.kind === "using-buffer"
        ? "warning"
        : "success";

  return (
    <section className="status-panel" aria-label="Delivery status">
      <h2 className="sr-only">Status</h2>

      <div className={"status-strip " + label.tone}>
        <Badge
          tone={badge.tone}
          icon={
            <span aria-hidden="true" className="badge-glyph">
              {label.glyph}
            </span>
          }
        >
          {badge.word}
        </Badge>
        <div className="status-strip-text">
          <p className={"status-line " + label.tone}>
            <strong>{label.text}</strong>
          </p>
          {label.endDate && <p className="status-enddate">{label.endDate}</p>}
        </div>
      </div>

      {status.teamScope && <TeamScopeNote scope={status.teamScope} />}
      {pastInProgress && !specTabs && (
        <PastInProgressOption option={pastInProgress} />
      )}

      {suspiciousLead(status) && (
        <Callout tone="warning">
          Jira shows {days(status.earnedDays)} plan days finished, while the
          plan expected only {days(status.plannedDays)} by today. That often
          means the plan is slower than what really happened: a start date later
          than when the work began, or fewer people than actually worked on it.{" "}
          {onOpenProject && (
            <button type="button" className="link-btn" onClick={onOpenProject}>
              Check the project
            </button>
          )}
        </Callout>
      )}

      {!comparable && (
        <Callout tone="info">
          <p>{status.reason ?? "Nothing to compare against yet."}</p>
          {children}
        </Callout>
      )}

      {planStale && (
        <Callout tone="warning">
          {planStale.storedEnd
            ? `The plan on the project page is out of date: it finishes ${planStale.storedEnd}, but with today's tasks, estimates, people and days off it finishes ${planStale.currentEnd ?? "—"} (with buffer). The numbers here use the up-to-date plan. Re-run the plan so the project page matches.`
            : "The project has no plan yet. The numbers here come from running it now; press Run Plan on the project to keep one."}{" "}
          {onOpenProject && (
            <button type="button" className="link-btn" onClick={onOpenProject}>
              Open the project
            </button>
          )}
        </Callout>
      )}

      {comparable && (
        <StatRow>
          <StatTile
            icon={<Icon name="calendar" size={18} />}
            label={
              (status.scope === "development"
                ? "Development finish without buffer"
                : "Finish without buffer") +
              (status.window ? " (your dates)" : "")
            }
            value={status.unbufferedEnd ?? "—"}
          />
          <StatTile
            icon={<Icon name="trend" size={18} />}
            tone={finishTone}
            label="Projected finish"
            value={status.projectedFinish ?? "—"}
          />
          {status.deadlines?.devEndDate && (
            <StatTile
              icon={<Icon name="flag" size={18} />}
              label={
                status.deadlines.devEndFromPlan
                  ? "Development ends (plan)"
                  : "Development ends (custom)"
              }
              value={status.deadlines.devEndDate}
            />
          )}
          <StatTile
            icon={<Icon name="flag" size={18} />}
            label={
              status.deadlines && !status.deadlines.endDateFromPlan
                ? "End date (custom)"
                : "End date (plan, with buffer)"
            }
            value={status.deadlines?.endDate ?? status.bufferedEnd ?? "—"}
          />
        </StatRow>
      )}

      <div className={comparable ? "grid-2 status-facts" : "status-facts"}>
        {comparable && (
          <Panel
            title="Buffer"
            icon={<Icon name="gauge" size={17} />}
            className="status-buffer"
          >
            <BufferMeter status={status} />
            <dl className="fact-grid">
              <Fact
                label={
                  criticalName(status)
                    ? `Variance (${status.critical}, vs. finish without buffer)`
                    : "Variance (vs. finish without buffer)"
                }
                value={`${status.varianceDays > 0 ? "+" : ""}${days(status.varianceDays)} d`}
              />
              <Fact
                label={
                  status.deadlineKind === "end" &&
                  (status.deadlines?.endDateFromPlan ?? true)
                    ? "Schedule buffer"
                    : `Slack before ${deadlineName(status)}`
                }
                value={`${days(status.bufferDays)} d`}
              />
              <Fact
                label="Effort buffer"
                value={`${days(status.effortBufferDays)} d`}
              />
              <Fact
                label="Rounding slack"
                value={`${days(status.roundingBufferDays)} d`}
              />
            </dl>
          </Panel>
        )}
        <Panel title="Progress" icon={<Icon name="chart" size={17} />}>
          <dl className="fact-grid">
            {comparable && (
              <>
                <Fact
                  label="Planned so far"
                  value={`${days(status.plannedDays)} d`}
                />
                <Fact label="Earned" value={`${days(status.earnedDays)} d`} />
                <Fact
                  label="Plan remaining"
                  value={`${days(status.planRemainingDays)} d`}
                />
              </>
            )}
            <Fact
              label="Jira estimated"
              value={`${days(status.jiraSetDays)} d`}
            />
            <Fact
              label="Jira spent"
              value={`${days(status.jiraSpentDays)} d`}
            />
            <Fact
              label="Jira remaining"
              value={`${days(status.jiraRemainingDays)} d`}
            />
          </dl>
        </Panel>
      </div>

      {comparable && awaitingClose && (
        <AwaitingClose status={status} whatIf={awaitingClose} />
      )}

      {specTabs && (
        <SpecializationTable
          rows={status.bySpecialization}
          status={status}
          awaitingClose={awaitingClose}
          option={
            pastInProgress && <PastInProgressOption option={pastInProgress} />
          }
        />
      )}

      {comparable && (
        <p className="muted status-footnote">
          Days here are team working days: weekends and days when the whole team
          is off (holidays) don't count, and a day when half the team is off
          counts as half.
        </p>
      )}
    </section>
  );
}
