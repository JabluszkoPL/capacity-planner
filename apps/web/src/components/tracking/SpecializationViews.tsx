import { useCallback, useId, useState } from "react";
import type {
  AwaitingCloseWhatIf,
  SpecializationStatus,
  TrackerStatus,
} from "@planner/core";
import {
  SpecDetails,
  days,
  hasSpecDetails,
  marginText,
  rowDeadlineName,
  specializationLabel,
  deadlineName,
} from "./StatusPanel";
import "./specViews.css";

/**
 * Six ways to read the same per-specialization status, switchable in place so
 * they can be compared on one tracker's data. The table is the original and
 * stays the default; the others draw the same numbers.
 *
 * Every view keeps the status in words (glyph + text) next to its marks, so
 * colour is never the only carrier (docs/ACCESSIBILITY.md).
 */
export type SpecView =
  "table" | "timeline" | "finish" | "progress" | "margin" | "cards";

export const SPEC_VIEWS: { id: SpecView; label: string; about: string }[] = [
  {
    id: "table",
    label: "Table",
    about: "Every number in words, one row per specialization.",
  },
  {
    id: "timeline",
    label: "Timeline",
    about:
      "Each specialization's plan on the calendar: work done fills the bar, then its buffer up to the deadline, and the diamond where it is projected to finish. Done fill behind the today line means behind.",
  },
  {
    id: "finish",
    label: "Finish dates",
    about:
      "Zoomed on the end: the hollow dot is the finish without buffer, the solid dot the projected finish, the line between them the slip. The tick is the deadline.",
  },
  {
    id: "progress",
    label: "Progress",
    about:
      "Work done out of each specialization's total; the tick is what the plan expected done by today.",
  },
  {
    id: "margin",
    label: "Buffer & margin",
    about:
      "Working days to spare before the deadline (right of the line) or late after it (left). The outline is the specialization's own buffer, the hatched part the share already spent.",
  },
  {
    id: "cards",
    label: "Cards",
    about:
      "One card per specialization: status, a small timeline, progress and the key dates.",
  },
];

const STORAGE_KEY = "planner.tracker.specView";

function readView(): SpecView {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v && SPEC_VIEWS.some((s) => s.id === v)) return v as SpecView;
  } catch {
    // Storage blocked: the table is a fine default.
  }
  return "table";
}

/** The picked view, remembered per device (a view preference, not data). */
export function useSpecView(): [SpecView, (v: SpecView) => void] {
  const [view, setView] = useState<SpecView>(readView);
  const set = useCallback((v: SpecView) => {
    setView(v);
    try {
      localStorage.setItem(STORAGE_KEY, v);
    } catch {
      // Not remembered; still switched.
    }
  }, []);
  return [view, set];
}

/** Native radios, so arrow keys move between views as in any radio group. */
export function SpecViewSwitch({
  value,
  onChange,
  children,
}: {
  value: SpecView;
  onChange: (v: SpecView) => void;
  /** Shown on the same row as the tabs, after them. */
  children?: React.ReactNode;
}) {
  const name = useId();
  const about = SPEC_VIEWS.find((v) => v.id === value)?.about;
  return (
    <div className="spec-view-bar">
      <div className="spec-view-row">
        <fieldset className="spec-view-switch">
          <legend className="sr-only">Show specializations as</legend>
          {SPEC_VIEWS.map((v) => (
            <label key={v.id} className={value === v.id ? "on" : undefined}>
              <input
                type="radio"
                name={name}
                value={v.id}
                checked={value === v.id}
                onChange={() => onChange(v.id)}
              />
              {v.label}
            </label>
          ))}
        </fieldset>
        {children}
      </div>
      {about && <p className="muted spec-view-about">{about}</p>}
    </div>
  );
}

// --- dates -----------------------------------------------------------------

const DAY_MS = 86_400_000;

function dayNum(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
}

function isoOf(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

interface Domain {
  from: number;
  to: number;
}

function domainOf(dates: (string | null | undefined)[]): Domain | null {
  const nums = dates.filter((d): d is string => !!d).map(dayNum);
  if (nums.length === 0) return null;
  let from = Math.min(...nums);
  let to = Math.max(...nums);
  const span = Math.max(to - from, 14);
  const pad = Math.max(2, Math.round(span * 0.04));
  from -= pad;
  to += pad;
  return { from, to };
}

/** Percent across the domain, clamped so a mark never leaves its lane. */
function at(d: Domain, iso: string): number {
  const p = ((dayNum(iso) - d.from) / (d.to - d.from)) * 100;
  return Math.min(100, Math.max(0, p));
}

const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");

function shortDate(iso: string): string {
  const [, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}

/** Month starts (or Mondays on a short range), thinned to fit. */
function ticks(d: Domain): { pos: number; label: string }[] {
  const out: { pos: number; label: string }[] = [];
  const span = d.to - d.from;
  if (span <= 60) {
    for (let n = Math.ceil(d.from); n <= d.to; n++) {
      // 1970-01-01 was a Thursday, so Monday is n % 7 === 4.
      if (((n % 7) + 7) % 7 !== 4) continue;
      out.push({
        pos: ((n - d.from) / span) * 100,
        label: shortDate(isoOf(n)),
      });
    }
    return out;
  }
  const start = new Date(d.from * DAY_MS);
  let y = start.getUTCFullYear();
  let m = start.getUTCMonth() + 1;
  const months: { n: number; y: number; m: number }[] = [];
  for (;;) {
    if (m > 11) {
      m = 0;
      y++;
    }
    const n = Date.UTC(y, m, 1) / DAY_MS;
    if (n > d.to) break;
    months.push({ n, y, m });
    m++;
  }
  const step = Math.max(1, Math.ceil(months.length / 8));
  months.forEach((t, i) => {
    if (i % step !== 0) return;
    const yr = i === 0 || t.m === 0 ? ` ’${String(t.y).slice(2)}` : "";
    out.push({ pos: ((t.n - d.from) / span) * 100, label: MONTHS[t.m] + yr });
  });
  return out;
}

// --- per-row geometry ------------------------------------------------------

interface RowDates {
  start: string | null;
  /** Its finish without buffer; for end-phase work, the end date. */
  planEnd: string | null;
  deadline: string | null;
  projected: string | null;
}

function rowDates(r: SpecializationStatus, status: TrackerStatus): RowDates {
  if (r.phase) {
    return {
      start: r.phase.mustStartBy ?? r.phase.latestStart ?? r.firstStart,
      planEnd: r.phase.to,
      deadline: r.phase.to,
      projected: r.projectedFinish,
    };
  }
  return {
    start: r.firstStart,
    planEnd: r.unbufferedEnd,
    deadline: status.deadline ?? status.bufferedEnd,
    projected: r.projectedFinish,
  };
}

function share(part: number, total: number): number {
  return total > 0 ? Math.min(100, Math.max(0, (part / total) * 100)) : 0;
}

function signed(n: number): string {
  const r = Number(n.toFixed(1));
  return `${r > 0 ? "+" : r < 0 ? "−" : ""}${days(Math.abs(r))} d`;
}

/** Name and verdict, the part of every view that is plain text. */
function RowLabel({
  r,
  status,
}: {
  r: SpecializationStatus;
  status: TrackerStatus;
}) {
  const label = specializationLabel(r, `the ${deadlineName(status)}`);
  return (
    <div className="sv-label">
      <span className="sv-name">
        {r.specialization}
        {r.phase && <span className="muted"> · end phase</span>}
      </span>
      <span className={"sv-verdict status-cell " + label.tone}>
        <span aria-hidden="true">{label.glyph} </span>
        {label.text}
      </span>
    </div>
  );
}

function rowSummary(r: SpecializationStatus, status: TrackerStatus): string {
  const d = rowDates(r, status);
  return [
    `${r.specialization}: ${specializationLabel(r, `the ${deadlineName(status)}`).text}`,
    `${days(r.earnedDays)} of ${days(r.totalDays)} plan days done, ${days(r.plannedDays)} expected by today`,
    d.planEnd && `finish without buffer ${d.planEnd}`,
    d.projected && `projected finish ${d.projected}`,
    d.deadline && `${rowDeadlineName(r, status)} ${d.deadline}`,
    marginText(r),
  ]
    .filter(Boolean)
    .join("; ");
}

// --- the shared calendar frame --------------------------------------------

function Axis({ domain }: { domain: Domain }) {
  return (
    <div className="sv-axis" aria-hidden="true">
      {ticks(domain).map((t) => (
        <span key={t.pos} className="sv-tick" style={{ left: `${t.pos}%` }}>
          {t.label}
        </span>
      ))}
    </div>
  );
}

function TodayLine({ domain, today }: { domain: Domain; today: string }) {
  return (
    <span
      className="sv-today"
      style={{ left: `${at(domain, today)}%` }}
      aria-hidden="true"
    />
  );
}

/** One specialization on the calendar: plan, progress, buffer, slip. */
function TimelineLane({
  r,
  status,
  domain,
  compact = false,
}: {
  r: SpecializationStatus;
  status: TrackerStatus;
  domain: Domain;
  compact?: boolean;
}) {
  const d = rowDates(r, status);
  const tone = specializationLabel(r).tone;
  const left = d.start ? at(domain, d.start) : null;
  const right = d.planEnd ? at(domain, d.planEnd) : null;
  const dl = d.deadline ? at(domain, d.deadline) : null;
  const proj = d.projected ? at(domain, d.projected) : null;
  const doneShare = share(r.earnedDays, r.totalDays);
  return (
    <div
      className={"sv-lane" + (compact ? " compact" : "")}
      role="img"
      aria-label={rowSummary(r, status)}
    >
      {left !== null && right !== null && right > left && (
        <span
          className="sv-plan"
          style={{ left: `${left}%`, width: `${right - left}%` }}
          title={`Plan without buffer: ${d.start} → ${d.planEnd} · ${days(r.earnedDays)} of ${days(r.totalDays)} d done`}
        >
          <span className="sv-plan-done" style={{ width: `${doneShare}%` }} />
        </span>
      )}
      {!r.phase &&
        r.kind !== "done" &&
        right !== null &&
        dl !== null &&
        dl > right && (
          <span
            className="sv-buffer"
            style={{ left: `${right}%`, width: `${dl - right}%` }}
            title={`Buffer: ${d.planEnd} → ${d.deadline}`}
          />
        )}
      {r.phase?.latestStart && (
        <span
          className="sv-latest"
          style={{ left: `${at(domain, r.phase.latestStart)}%` }}
          title={`Latest start without buffer: ${r.phase.latestStart}`}
        />
      )}
      {dl !== null && proj !== null && proj > dl && (
        <span
          className="sv-late"
          style={{ left: `${dl}%`, width: `${proj - dl}%` }}
          title={`Late: ${d.deadline} → ${d.projected}`}
        />
      )}
      {dl !== null && (
        <span
          className="sv-deadline"
          style={{ left: `${dl}%` }}
          title={`${rowDeadlineName(r, status)}: ${d.deadline}`}
        />
      )}
      {proj !== null && (
        <span
          className={"sv-diamond " + tone}
          style={{ left: `${proj}%` }}
          title={`Projected finish: ${d.projected}`}
        />
      )}
    </div>
  );
}

function Legend({ items }: { items: { swatch: string; text: string }[] }) {
  return (
    <ul className="sv-legend" aria-hidden="true">
      {items.map((i) => (
        <li key={i.text}>
          <span className={"sv-swatch " + i.swatch} />
          {i.text}
        </li>
      ))}
    </ul>
  );
}

interface ViewProps {
  rows: SpecializationStatus[];
  status: TrackerStatus;
  awaitingClose?: AwaitingCloseWhatIf | null;
}

function allDates(rows: SpecializationStatus[], status: TrackerStatus) {
  const out: (string | null)[] = [status.today];
  for (const r of rows) {
    const d = rowDates(r, status);
    out.push(d.start, d.planEnd, d.deadline, d.projected);
  }
  return out;
}

// --- 1. timeline -----------------------------------------------------------

function TimelineView({ rows, status }: ViewProps) {
  const domain = domainOf(allDates(rows, status));
  if (!domain) return <NoDates />;
  return (
    <div className="sv-chart">
      <Legend
        items={[
          { swatch: "plan", text: "Plan without buffer" },
          { swatch: "done", text: "Work done" },
          { swatch: "buffer", text: "Buffer" },
          { swatch: "late", text: "Late" },
          { swatch: "diamond", text: "Projected finish" },
          { swatch: "deadline", text: "Deadline" },
          { swatch: "today", text: `Today (${shortDate(status.today)})` },
        ]}
      />
      <div className="sv-grid">
        <div />
        <Axis domain={domain} />
        {rows.map((r) => (
          <Row key={r.specialization}>
            <RowLabel r={r} status={status} />
            <div className="sv-track">
              <TodayLine domain={domain} today={status.today} />
              <TimelineLane r={r} status={status} domain={domain} />
            </div>
          </Row>
        ))}
      </div>
    </div>
  );
}

/** A grid row that stays one list item for assistive tech. */
function Row({ children }: { children: React.ReactNode }) {
  return <div className="sv-row">{children}</div>;
}

function NoDates() {
  return (
    <p className="muted">
      No dates to draw yet — switch to the table for this reading.
    </p>
  );
}

// --- 2. finish dates (dumbbell) -------------------------------------------

function FinishView({ rows, status }: ViewProps) {
  const dates: (string | null)[] = [status.today];
  for (const r of rows) {
    const d = rowDates(r, status);
    dates.push(d.planEnd, d.deadline, d.projected);
  }
  const domain = domainOf(dates);
  if (!domain) return <NoDates />;
  return (
    <div className="sv-chart">
      <Legend
        items={[
          { swatch: "dot-hollow", text: "Finish without buffer" },
          { swatch: "dot", text: "Projected finish" },
          { swatch: "deadline", text: "Deadline" },
          { swatch: "today", text: `Today (${shortDate(status.today)})` },
        ]}
      />
      <div className="sv-grid with-end">
        <div />
        <Axis domain={domain} />
        <div />
        {rows.map((r) => {
          const d = rowDates(r, status);
          const tone = specializationLabel(r).tone;
          const plan = d.planEnd ? at(domain, d.planEnd) : null;
          const proj = d.projected ? at(domain, d.projected) : null;
          const dl = d.deadline ? at(domain, d.deadline) : null;
          const late = r.marginDays !== null && r.marginDays <= -0.5;
          return (
            <Row key={r.specialization}>
              <RowLabel r={r} status={status} />
              <div className="sv-track">
                <TodayLine domain={domain} today={status.today} />
                <div
                  className="sv-lane"
                  role="img"
                  aria-label={rowSummary(r, status)}
                >
                  {plan !== null && proj !== null && (
                    <span
                      className={"sv-slip " + tone}
                      style={{
                        left: `${Math.min(plan, proj)}%`,
                        width: `${Math.abs(proj - plan)}%`,
                      }}
                    />
                  )}
                  {dl !== null && (
                    <span
                      className="sv-deadline"
                      style={{ left: `${dl}%` }}
                      title={`${rowDeadlineName(r, status)}: ${d.deadline}`}
                    />
                  )}
                  {plan !== null && (
                    <span
                      className="sv-dot hollow"
                      style={{ left: `${plan}%` }}
                      title={`Finish without buffer: ${d.planEnd}`}
                    />
                  )}
                  {proj !== null && (
                    <span
                      className={"sv-dot " + tone}
                      style={{ left: `${proj}%` }}
                      title={`Projected finish: ${d.projected}`}
                    />
                  )}
                </div>
              </div>
              <div className={"sv-end num" + (late ? " status-cell bad" : "")}>
                {d.projected ?? "—"}
                <span className="spec-detail muted">{marginText(r)}</span>
              </div>
            </Row>
          );
        })}
      </div>
    </div>
  );
}

// --- 3. progress (bullets) ------------------------------------------------

function ProgressView({ rows, status }: ViewProps) {
  return (
    <div className="sv-chart">
      <Legend
        items={[
          { swatch: "done", text: "Done" },
          { swatch: "expected", text: "Expected by today" },
          { swatch: "plan", text: "Total" },
        ]}
      />
      <div className="sv-grid with-end">
        {rows.map((r) => {
          const tone = specializationLabel(r).tone;
          const done = share(r.earnedDays, r.totalDays);
          const expected = share(r.plannedDays, r.totalDays);
          return (
            <Row key={r.specialization}>
              <RowLabel r={r} status={status} />
              <div
                className="sv-bullet"
                role="img"
                aria-label={rowSummary(r, status)}
                title={`${days(r.earnedDays)} of ${days(r.totalDays)} d done · ${days(r.plannedDays)} d expected by today`}
              >
                <span
                  className={"sv-bullet-done " + tone}
                  style={{ width: `${done}%` }}
                />
                {r.plannedDays > 0 && (
                  <span
                    className="sv-bullet-expected"
                    style={{ left: `${expected}%` }}
                  />
                )}
              </div>
              <div className="sv-end num">
                {Math.round(done)}%{" "}
                <span className="muted">
                  {days(r.earnedDays)} / {days(r.plannedDays)} d
                </span>
                <span className="spec-detail muted">
                  of {days(r.totalDays)} d · {signed(r.varianceDays)} vs plan
                </span>
              </div>
            </Row>
          );
        })}
      </div>
    </div>
  );
}

// --- 4. buffer & margin (diverging) ---------------------------------------

function MarginView({ rows, status }: ViewProps) {
  let maxLate = 0;
  let maxSpare = 0;
  // A finished specialization's margin is history, not runway: left out of
  // the scale so it doesn't squash the ones still running.
  for (const r of rows) {
    if (r.kind === "done") continue;
    const m = r.marginDays ?? 0;
    maxLate = Math.max(maxLate, -m);
    maxSpare = Math.max(maxSpare, m, r.bufferDays ?? 0);
  }
  const span = maxLate + maxSpare;
  if (span <= 0) return <NoDates />;
  const x = (n: number) => ((n + maxLate) / span) * 100;
  const zero = x(0);
  return (
    <div className="sv-chart">
      <Legend
        items={[
          { swatch: "spare", text: "Days to spare" },
          { swatch: "spent", text: "Buffer spent" },
          { swatch: "outline", text: "Its buffer" },
          { swatch: "late", text: "Days late" },
        ]}
      />
      <div className="sv-grid with-end">
        <div />
        <div className="sv-axis margin" aria-hidden="true">
          {maxLate > 0 && (
            <span className="sv-tick start" style={{ left: "0%" }}>
              {days(maxLate)} d late
            </span>
          )}
          <span className="sv-tick zero" style={{ left: `${zero}%` }}>
            deadline
          </span>
          {maxSpare > 0 && (
            <span className="sv-tick end" style={{ left: "100%" }}>
              {days(maxSpare)} d to spare
            </span>
          )}
        </div>
        <div />
        {rows.map((r) => {
          const tone = specializationLabel(r).tone;
          const finished = r.kind === "done";
          const m = finished ? null : r.marginDays;
          const buffer = finished ? 0 : (r.bufferDays ?? 0);
          return (
            <Row key={r.specialization}>
              <RowLabel r={r} status={status} />
              <div
                className="sv-lane margin"
                role="img"
                aria-label={rowSummary(r, status)}
              >
                <span className="sv-zero" style={{ left: `${zero}%` }} />
                {buffer > 0 && (
                  <span
                    className="sv-outline"
                    style={{ left: `${zero}%`, width: `${x(buffer) - zero}%` }}
                    title={`Its buffer: ${days(buffer)} working days`}
                  />
                )}
                {m !== null && buffer > 0 && m < buffer && (
                  <span
                    className="sv-spent"
                    style={{
                      left: `${x(Math.max(m, 0))}%`,
                      width: `${x(buffer) - x(Math.max(m, 0))}%`,
                    }}
                    title={`Buffer spent: ${days(Math.min(buffer, buffer - m))} of ${days(buffer)} d`}
                  />
                )}
                {m !== null && m > 0 && (
                  <span
                    className={"sv-spare " + tone}
                    style={{ left: `${zero}%`, width: `${x(m) - zero}%` }}
                    title={`${days(m)} working days to spare`}
                  />
                )}
                {m !== null && m < 0 && (
                  <span
                    className="sv-late solid"
                    style={{ left: `${x(m)}%`, width: `${zero - x(m)}%` }}
                    title={`${days(-m)} working days late`}
                  />
                )}
              </div>
              <div
                className={
                  "sv-end num" +
                  (m !== null && m <= -0.5 ? " status-cell bad" : "")
                }
              >
                {finished ? "finished" : marginText(r)}
                {!finished && (
                  <span className="spec-detail muted">
                    {rowDeadlineName(r, status)}
                  </span>
                )}
              </div>
            </Row>
          );
        })}
      </div>
    </div>
  );
}

// --- 5. cards -------------------------------------------------------------

function CardsView({ rows, status, awaitingClose }: ViewProps) {
  const domain = domainOf(allDates(rows, status));
  return (
    <ul className="sv-cards">
      {rows.map((r) => {
        const label = specializationLabel(r, `the ${deadlineName(status)}`);
        const d = rowDates(r, status);
        const done = share(r.earnedDays, r.totalDays);
        const expected = share(r.plannedDays, r.totalDays);
        const late = r.marginDays !== null && r.marginDays <= -0.5;
        return (
          <li key={r.specialization} className={"sv-card " + label.tone}>
            <h4 className="sv-card-title">
              {r.specialization}
              {r.phase && <span className="muted"> · end phase</span>}
            </h4>
            <p className={"sv-card-verdict status-cell " + label.tone}>
              <span aria-hidden="true">{label.glyph} </span>
              {label.text}
            </p>
            {domain && (
              <div className="sv-track">
                <TodayLine domain={domain} today={status.today} />
                <TimelineLane r={r} status={status} domain={domain} compact />
              </div>
            )}
            <div className="sv-card-progress">
              <div className="sv-bullet small" aria-hidden="true">
                <span
                  className={"sv-bullet-done " + label.tone}
                  style={{ width: `${done}%` }}
                />
                {r.plannedDays > 0 && (
                  <span
                    className="sv-bullet-expected"
                    style={{ left: `${expected}%` }}
                  />
                )}
              </div>
              <span className="muted">
                {days(r.earnedDays)} / {days(r.plannedDays)} d expected · of{" "}
                {days(r.totalDays)}
              </span>
            </div>
            <dl className="sv-card-facts">
              <div>
                <dt>Finish without buffer</dt>
                <dd>{d.planEnd ?? "—"}</dd>
              </div>
              <div>
                <dt>Projected</dt>
                <dd>{d.projected ?? "—"}</dd>
              </div>
              <div>
                <dt>Before its {rowDeadlineName(r, status)}</dt>
                <dd className={late ? "status-cell bad" : undefined}>
                  {marginText(r)}
                </dd>
              </div>
            </dl>
            {hasSpecDetails(r, awaitingClose) && (
              <details className="sv-card-more">
                <summary>Details</summary>
                <SpecDetails
                  r={r}
                  status={status}
                  awaitingClose={awaitingClose}
                />
              </details>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Any view but the table. */
export function SpecChartView({
  view,
  ...props
}: ViewProps & { view: Exclude<SpecView, "table"> }) {
  switch (view) {
    case "timeline":
      return <TimelineView {...props} />;
    case "finish":
      return <FinishView {...props} />;
    case "progress":
      return <ProgressView {...props} />;
    case "margin":
      return <MarginView {...props} />;
    case "cards":
      return <CardsView {...props} />;
  }
}
