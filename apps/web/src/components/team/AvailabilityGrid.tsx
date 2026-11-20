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
import { Panel } from "../ui/Panel";
import { Avatar } from "../ui/IconTile";
import { Icon } from "../ui/Icon";
import {
  addDays,
  diffDays,
  fromISO,
  isWeekend,
  startOfWeek,
  toISO,
  todayISO,
  colorFor,
  mergedOffDays,
} from "@planner/core";

const GRID_DAYS = 371; // 53 weeks (~1 year) forward, whole weeks from Monday
const WEEKS = GRID_DAYS / 7;

const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

/** "Nov 16 – 22", or "Nov 30 – Dec 6" across a month boundary. */
function weekLabel(start: Date, end: Date): string {
  const from = MONTHS[start.getMonth()] + " " + start.getDate();
  const to =
    start.getMonth() === end.getMonth()
      ? String(end.getDate())
      : MONTHS[end.getMonth()] + " " + end.getDate();
  return `${from} – ${to}`;
}

interface AvailabilityGridProps {
  /** Show only this team. Absent = every team. */
  teamId?: string;
}

/**
 * Days off for everyone, a year ahead: a week band and a day row above each
 * team, one row of day cells per person, and a row counting who is available
 * each working day. Click a day to toggle it, drag along a row to paint
 * several, or Tab to a day and press Enter/Space.
 */
export function AvailabilityGrid({ teamId }: AvailabilityGridProps = {}) {
  const { state, actions } = useAppStore();
  const offDays = mergedOffDays(state.teams);

  // Only teams that actually have people to show. Members are grouped under
  // their team so each roster reads as its own block.
  const shownTeams = state.teams.filter(
    (t) => t.members.length > 0 && (!teamId || t.id === teamId),
  );

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
  const isos = useMemo(() => dates.map(toISO), [dates]);

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

  const controls = (
    <div className="offgrid-controls">
      <label htmlFor="offgrid-start">Start date</label>
      <input
        id="offgrid-start"
        type="date"
        value={startOverride ?? todayISO()}
        onChange={(e) => setStartOverride(e.target.value)}
      />
      {startOverride && (
        <Button small onClick={() => setStartOverride(null)}>
          Jump to today
        </Button>
      )}
    </div>
  );

  if (shownTeams.length === 0) {
    return (
      <Panel
        title="Availability"
        icon={<Icon name="calendar" size={18} />}
        className="availability-panel"
      >
        <EmptyState
          compact
          title="No availability to show"
          message="Add team members above to mark their days off."
        />
      </Panel>
    );
  }

  const dayColumns = `repeat(${GRID_DAYS}, var(--offgrid-col-w))`;

  // Both the frozen column and the timeline are independent grids, so they
  // can't share row sizing implicitly. We build one explicit row template and
  // apply it to both so every row lines up exactly. Each team block is a
  // spacer (except the first), a week band, a day row, a row per member and a
  // totals row; the dates repeat above every team so they stay visible
  // however far down you scroll.
  const rowTemplate = shownTeams
    .flatMap((t, ti) => [
      ...(ti > 0 ? ["var(--offgrid-gap-h)"] : []),
      "var(--offgrid-week-h)",
      "var(--offgrid-head-h)",
      ...t.members.map(() => "var(--offgrid-row-h)"),
      "var(--offgrid-total-h)",
    ])
    .join(" ");

  const todayWeek = Math.floor(todayIndex / 7);

  return (
    <Panel
      title="Availability"
      subtitle="Click a day to toggle it, or drag across a row to paint several days off at once. Weekends are greyed out."
      icon={<Icon name="calendar" size={18} />}
      actions={controls}
      className="availability-panel"
      flush
    >
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
              <div className="offgrid-teamname">
                <span className="offgrid-teamname-text">{t.name}</span>
                <span className="offgrid-teamcount">{t.members.length}</span>
              </div>
              <div className="offgrid-corner">Person</div>
              {t.members.map((m) => (
                <div key={m.id} className="offgrid-member">
                  <Avatar
                    name={m.name}
                    color={colorFor(m.specialization)}
                    size="sm"
                  />
                  <span className="offgrid-member-text">
                    <span className="offgrid-member-name">{m.name}</span>
                    <span className="spec-tag">{m.specialization || "—"}</span>
                  </span>
                </div>
              ))}
              <div className="offgrid-total-label">Available</div>
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
          {shownTeams.map((t, ti) => (
            <Fragment key={t.id}>
              {ti > 0 && <div className="offgrid-gap-band" />}
              {Array.from({ length: WEEKS }, (_, w) => (
                <div
                  key={"w" + w}
                  className={
                    "offgrid-week" + (w === todayWeek ? " current" : "")
                  }
                  aria-hidden="true"
                >
                  {weekLabel(dates[w * 7]!, dates[w * 7 + 6]!)}
                </div>
              ))}
              {dates.map((d, i) => (
                <div
                  key={"h" + i}
                  className={
                    "offgrid-daylabel" +
                    (isWeekend(d) ? " weekend" : "") +
                    (i === todayIndex ? " today" : "")
                  }
                  aria-hidden="true"
                >
                  <span className="offgrid-weekday">
                    {WEEKDAYS[d.getDay()]}
                  </span>
                  {d.getDate()}
                </div>
              ))}
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
              {dates.map((d, i) => {
                if (isWeekend(d)) {
                  return (
                    <div
                      key={"t" + i}
                      className="offgrid-total weekend"
                      aria-hidden="true"
                    />
                  );
                }
                const total = t.members.length;
                const free = t.members.filter(
                  (m) => !isOff(m.id, isos[i]!),
                ).length;
                return (
                  <div
                    key={"t" + i}
                    className={
                      "offgrid-total" +
                      (free < total ? " short" : "") +
                      (i === todayIndex ? " today" : "")
                    }
                    title={`${t.name} · ${isos[i]}: ${free} of ${total} available`}
                    aria-hidden="true"
                  >
                    {free}
                  </div>
                );
              })}
            </Fragment>
          ))}
        </div>
      </div>
      <div className="offgrid-legend" aria-hidden="true">
        <span className="offgrid-legend-item">
          <span className="offgrid-swatch off">
            <Icon name="calendar" size={10} />
          </span>
          Day off
        </span>
        <span className="offgrid-legend-item">
          <span className="offgrid-swatch weekend" />
          Weekend
        </span>
        <span className="offgrid-legend-item">
          <span className="offgrid-swatch today" />
          Today
        </span>
        <span className="offgrid-legend-item">
          <span className="offgrid-swatch total" />
          Not everyone available
        </span>
      </div>
    </Panel>
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
          (i === todayIndex ? " today" : "") +
          (d.getDay() === 1 ? " week-start" : "");
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
          >
            {off && <Icon name="calendar" size={11} />}
          </div>
        );
      })}
    </>
  );
}
