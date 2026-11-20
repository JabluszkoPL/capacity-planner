import { useId } from "react";
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
  const hatch = useId();
  const recent = samples.slice(-WINDOW);
  if (recent.length === 0) return null;

  // The scale covers each reading's buffer too, so the hatched zone that
  // shows how much runway there was always fits.
  const peak = Math.max(
    1,
    ...recent.map((s) => Math.abs(s.varianceDays)),
    ...recent.map((s) => s.bufferDays),
  );

  const col = 48;
  const barWidth = 22;
  const half = 64;
  const top = 14;
  const width = recent.length * col;
  const zero = top + half;
  const height = top + half * 2 + 30;
  const scale = (n: number) => (n / peak) * (half - 4);

  return (
    <section
      className="panel tracking-panel history-panel"
      aria-label="History"
    >
      <h2 className="panel-title">History</h2>
      <p className="muted">
        Variance against the finish without buffer at each refresh, in working
        days. Above the line is ahead; below it is behind, and the hatched band
        is the buffer there was to absorb it.
      </p>

      <ul className="sv-legend history-legend" aria-hidden="true">
        <li>
          <span className="sv-swatch spare" />
          Ahead
        </li>
        <li>
          <span className="sv-swatch history-warn" />
          Behind, inside the buffer
        </li>
        <li>
          <span className="sv-swatch history-bad" />
          Behind, past the buffer
        </li>
        <li>
          <span className="sv-swatch buffer" />
          Buffer
        </li>
      </ul>

      <div className="history-chart">
        <svg
          className="variance-strip"
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`Variance over the last ${recent.length} readings, in working days`}
        >
          <defs>
            <pattern
              id={hatch}
              width="6"
              height="6"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <rect width="6" height="6" className="variance-hatch-bg" />
              <line x1="0" y1="0" x2="0" y2="6" className="variance-hatch" />
            </pattern>
          </defs>
          {recent.map((s, i) => {
            const x = i * col + (col - barWidth) / 2;
            const buffer = scale(s.bufferDays);
            const magnitude = scale(Math.abs(s.varianceDays));
            const ahead = s.varianceDays >= 0;
            // Behind but still inside the buffer reads as a warning; past it,
            // as a failure. Same three-way split as the status line.
            const tone = ahead
              ? "ok"
              : s.bufferDays > 0 && -s.varianceDays <= s.bufferDays
                ? "warn"
                : "bad";
            const value = `${s.varianceDays > 0 ? "+" : ""}${days(s.varianceDays)}`;
            return (
              <g key={s.date}>
                {buffer > 0 && (
                  <rect
                    x={x - 4}
                    y={zero}
                    width={barWidth + 8}
                    height={buffer}
                    fill={`url(#${hatch})`}
                    className="variance-buffer"
                  />
                )}
                <rect
                  className={"variance-bar " + tone}
                  x={x}
                  y={ahead ? zero - magnitude : zero}
                  width={barWidth}
                  height={Math.max(1, magnitude)}
                  rx={3}
                >
                  <title>{`${s.date}: ${value} days`}</title>
                </rect>
                <text
                  className="variance-value"
                  x={x + barWidth / 2}
                  y={ahead ? zero - magnitude - 4 : zero + magnitude + 11}
                  textAnchor="middle"
                >
                  {value}
                </text>
                <text
                  className="variance-date"
                  x={x + barWidth / 2}
                  y={height - 6}
                  textAnchor="middle"
                >
                  {s.date.slice(5)}
                </text>
              </g>
            );
          })}
          <line
            x1={0}
            y1={zero}
            x2={width}
            y2={zero}
            className="variance-axis"
          />
        </svg>
      </div>

      <div className="table-scroll">
        <table className="data-table history-table">
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
