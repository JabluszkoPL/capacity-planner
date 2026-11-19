import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useAppStore } from "@planner/client-runtime";
import { EmptyState } from "../ui/EmptyState";
import { Button } from "../ui/Button";
import {
  addDays,
  diffDays,
  fromISO,
  isWeekend,
  startOfWeek,
  toISO,
  todayISO,
  colorFor,
  allMembers,
  mergedOffDays,
} from "@planner/core";

const GRID_DAYS = 371; // 53 weeks (~1 year) forward, whole weeks from Monday

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function dayLabel(d: Date): string {
  // Show the month on the 1st and on Mondays, otherwise just the date.
  return d.getDate() === 1 || d.getDay() === 1
    ? MONTHS[d.getMonth()] + " " + d.getDate()
    : String(d.getDate());
}

export function AvailabilityGrid() {
  const { state, actions } = useAppStore();
  const members = allMembers(state.teams);
  const offDays = mergedOffDays(state.teams);

  // Grid normally opens on the current week, but a custom start date lets you
  // scroll the timeline back (or forward) to mark off-days for a period
  // you're re-planning, such as recreating a past estimate.
  const [startOverride, setStartOverride] = useState<string | null>(null);

  const { dates, todayIndex } = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const anchor = startOverride ? fromISO(startOverride) : today;
    const gridStart = startOfWeek(anchor);
    const ds = Array.from({ length: GRID_DAYS }, (_, i) =>
      addDays(gridStart, i),
    );
    return { dates: ds, todayIndex: diffDays(gridStart, today) };
  }, [startOverride]);

  // A paint stroke's state lives in a ref so it survives the re-renders that
  // each toggle triggers, and never itself causes a re-render.
  const paint = useRef<{
    active: boolean;
    value: boolean;
    memberId: string | null;
  }>({ active: false, value: false, memberId: null });

  useEffect(() => {
    const end = () => {
      paint.current.active = false;
    };
    document.addEventListener("mouseup", end);
    return () => document.removeEventListener("mouseup", end);
  }, []);

  const isOff = (memberId: string, iso: string) =>
    (offDays[memberId] ?? []).includes(iso);

  // Set a cell to a specific on/off value (toggle only when it differs).
  const setOff = (memberId: string, iso: string, value: boolean) => {
    if (isOff(memberId, iso) !== value) actions.toggleOffDay(memberId, iso);
  };

  const beginPaint = (memberId: string, iso: string) => {
    const value = !isOff(memberId, iso); // opposite of the first cell's state
    paint.current = { active: true, value, memberId };
    setOff(memberId, iso, value);
  };

  const continuePaint = (memberId: string, iso: string) => {
    const p = paint.current;
    // Same-row only — a drag must not bleed into another member's row.
    if (!p.active || p.memberId !== memberId) return;
    setOff(memberId, iso, p.value);
  };

  // Keyboard: focus a weekday cell and press Enter/Space to toggle that day.
  const toggleCell = (memberId: string, iso: string) => {
    actions.toggleOffDay(memberId, iso);
  };

  if (members.length === 0) {
    return (
      <div className="card">
        <h3 className="team-heading">Availability</h3>
        <EmptyState
          compact
          title="No availability to show"
          message="Add team members above to mark their days off."
        />
      </div>
    );
  }

  // Only teams that actually have people to show. Members are grouped under
  // their team so each roster reads as its own block.
  const shownTeams = state.teams.filter((t) => t.members.length > 0);

  const dayColumns = `repeat(${GRID_DAYS}, 26px)`;

  // Both the frozen column and the timeline are independent grids, so they
  // can't share row sizing implicitly. We build one explicit row template and
  // apply it to both so every row lines up exactly. Each team block is a
  // spacer (except the first), a repeated date-label header, a team-name row,
  // and a row per member — the date header repeats above every team so the
  // dates stay visible however far down you scroll.
  const rowTemplate = shownTeams
    .flatMap((t, ti) => [
      ...(ti > 0 ? ["var(--offgrid-gap-h)"] : []),
      "var(--offgrid-head-h)",
      "var(--offgrid-team-h)",
      ...t.members.map(() => "var(--offgrid-row-h)"),
    ])
    .join(" ");

  return (
    <div className="card">
      <h3 className="team-heading">Availability</h3>
      <p className="offgrid-hint">
        Click a day to toggle it, or drag across a row to paint several days off
        at once. Weekends are greyed out.
      </p>
      <div className="offgrid-controls">
        <div className="field">
          <label htmlFor="offgrid-start">Start date</label>
          <input
            id="offgrid-start"
            type="date"
            value={startOverride ?? todayISO()}
            onChange={(e) => setStartOverride(e.target.value)}
          />
        </div>
        {startOverride && (
          <Button small onClick={() => setStartOverride(null)}>
            Jump to today
          </Button>
        )}
      </div>
      <div className="grid-scroll">
        {/* Frozen member column. Kept as its own sticky sub-grid rather than a
            sticky first column inside the timeline grid: a sticky grid *item*
            is clamped to its own cell's box, so it would scroll out of view
            after a screenful. As a standalone flex child it stays pinned to
            the left edge for the whole scroll. Its rows use the same template
            as the timeline so the two align. */}
        <div
          className="offgrid-frozen"
          aria-hidden="true"
          style={{ gridTemplateRows: rowTemplate }}
        >
          {shownTeams.map((t, ti) => (
            <Fragment key={t.id}>
              {ti > 0 && <div className="offgrid-gap" />}
              <div className="offgrid-corner">Member</div>
              <div className="offgrid-teamname">
                {t.name}
                <span className="offgrid-teamcount">{t.members.length}</span>
              </div>
              {t.members.map((m) => (
                <div
                  key={m.id}
                  className="offgrid-member"
                  style={{
                    borderLeft: `4px solid ${colorFor(m.specialization)}`,
                  }}
                >
                  {m.name}
                  <br />
                  <span className="spec-tag">{m.specialization || "—"}</span>
                </div>
              ))}
            </Fragment>
          ))}
        </div>

        {/* Scrolling timeline */}
        <div
          className="offgrid"
          style={{
            gridTemplateColumns: dayColumns,
            gridTemplateRows: rowTemplate,
          }}
          role="grid"
          aria-label="Team availability, next 12 months"
        >
          {/* One block per team: the date-label header (repeated above every
              team so the dates stay in view), a full-width band marking the
              team boundary, then one row of day cells per member. */}
          {shownTeams.map((t, ti) => (
            <Fragment key={t.id}>
              {ti > 0 && <div className="offgrid-gap-band" />}
              {dates.map((d, i) => (
                <div
                  key={"h" + i}
                  className={
                    "offgrid-daylabel" +
                    (isWeekend(d) ? " weekend" : "") +
                    (i === todayIndex ? " today" : "")
                  }
                >
                  {dayLabel(d)}
                </div>
              ))}
              <div className="offgrid-team-band" />
              {t.members.map((m) => (
                <MemberRow
                  key={m.id}
                  memberId={m.id}
                  name={m.name}
                  dates={dates}
                  todayIndex={todayIndex}
                  isOff={isOff}
                  onCellDown={beginPaint}
                  onCellOver={continuePaint}
                  onCellToggle={toggleCell}
                />
              ))}
            </Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}

interface MemberRowProps {
  memberId: string;
  name: string;
  dates: Date[];
  todayIndex: number;
  isOff: (memberId: string, iso: string) => boolean;
  onCellDown: (memberId: string, iso: string) => void;
  onCellOver: (memberId: string, iso: string) => void;
  onCellToggle: (memberId: string, iso: string) => void;
}

function MemberRow({
  memberId,
  name,
  dates,
  todayIndex,
  isOff,
  onCellDown,
  onCellOver,
  onCellToggle,
}: MemberRowProps) {
  const onCellKeyDown = (e: KeyboardEvent<HTMLDivElement>, iso: string) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onCellToggle(memberId, iso);
    }
  };
  return (
    <>
      {dates.map((d, i) => {
        const iso = toISO(d);
        const weekend = isWeekend(d);
        const off = isOff(memberId, iso);
        const classes =
          "day-cell" +
          (weekend ? " weekend" : "") +
          (off ? " off" : "") +
          (i === todayIndex ? " today" : "");
        return (
          <div
            key={iso}
            className={classes}
            data-member={memberId}
            data-date={iso}
            role="gridcell"
            aria-label={`${name} · ${iso}${off ? " · off" : ""}`}
            title={`${name} · ${iso}${off ? " · OFF" : ""}`}
            // Weekdays are keyboard-operable: Tab to a cell, Enter/Space toggles.
            tabIndex={weekend ? undefined : 0}
            aria-pressed={weekend ? undefined : off}
            // Weekends are non-interactive: no paint handlers at all.
            onMouseDown={
              weekend
                ? undefined
                : (e) => {
                    e.preventDefault();
                    onCellDown(memberId, iso);
                  }
            }
            onMouseOver={weekend ? undefined : () => onCellOver(memberId, iso)}
            onKeyDown={weekend ? undefined : (e) => onCellKeyDown(e, iso)}
          />
        );
      })}
    </>
  );
}
