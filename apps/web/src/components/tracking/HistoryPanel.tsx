import type { TrackerSample } from "@planner/core";
import { days } from "./StatusPanel";

/** How many readings the strip and table show. */
const WINDOW = 10;

interface HistoryPanelProps {
  samples: TrackerSample[];
}

/**
 * The trend, which is the whole reason samples exist.
 *
 * A single refresh answers "are we behind today". Only the series answers the
 * question actually worth asking every few days: is the buffer going faster
 * this week than last? Drawn as inline SVG rather than with a chart library —
 * ten bars do not justify a dependency, and the repo's rule is to prefer a
 * small local implementation.
 */
export function HistoryPanel({ samples }: HistoryPanelProps) {
  const recent = samples.slice(-WINDOW);
  if (recent.length === 0) return null;

  const magnitudes = recent.map((s) => Math.abs(s.varianceDays));
  const peak = Math.max(1, ...magnitudes);

  const barWidth = 18;
  const gap = 6;
  const half = 26;
  const width = recent.length * (barWidth + gap);
  const height = half * 2 + 12;

  return (
    <section className="history-panel" aria-label="History">
      <h2 className="section-title">History</h2>

      <svg
        className="variance-strip"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Variance over the last ${recent.length} readings, in working days`}
      >
        <line x1={0} y1={half} x2={width} y2={half} className="variance-axis" />
        {recent.map((s, i) => {
          const magnitude = (Math.abs(s.varianceDays) / peak) * (half - 4);
          const ahead = s.varianceDays >= 0;
          // Behind but still inside the buffer reads as a warning; past it, as
          // a failure. Same three-way split as the status line.
          const tone = ahead
            ? "ok"
            : s.bufferDays > 0 && -s.varianceDays <= s.bufferDays
              ? "warn"
              : "bad";
          return (
            <rect
              key={s.date}
              className={"variance-bar " + tone}
              x={i * (barWidth + gap)}
              y={ahead ? half - magnitude : half}
              width={barWidth}
              height={Math.max(1, magnitude)}
            >
              <title>{`${s.date}: ${s.varianceDays > 0 ? "+" : ""}${days(s.varianceDays)} days`}</title>
            </rect>
          );
        })}
      </svg>

      <div className="table-scroll">
        <table className="history-table">
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Variance</th>
              <th scope="col">Buffer used</th>
              <th scope="col">Earned</th>
              <th scope="col">Jira remaining</th>
            </tr>
          </thead>
          <tbody>
            {[...recent].reverse().map((s) => (
              <tr key={s.date}>
                <td>{s.date}</td>
                <td className="num">
                  {s.varianceDays > 0 ? "+" : ""}
                  {days(s.varianceDays)} d
                </td>
                <td className="num">
                  {s.bufferDays > 0
                    ? `${days(s.bufferUsedDays)} / ${days(s.bufferDays)} d`
                    : "—"}
                </td>
                <td className="num">{days(s.earnedDays)} d</td>
                <td className="num">{days(s.jiraRemainingDays)} d</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
