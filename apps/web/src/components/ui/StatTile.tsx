import type { ReactNode } from "react";
import type { Tone } from "./Badge";

interface StatTileProps {
  label: ReactNode;
  value: ReactNode;
  /** A muted line under the value. */
  hint?: ReactNode;
  icon?: ReactNode;
  tone?: Tone;
}

/** One key number: "Forecast finish  Dec 13, 2026". Lay several in a .stat-row. */
export function StatTile({
  label,
  value,
  hint,
  icon,
  tone = "neutral",
}: StatTileProps) {
  return (
    <div className={`stat-tile stat-${tone}`}>
      {icon && <span className="stat-icon">{icon}</span>}
      <div className="stat-text">
        <div className="stat-label">{label}</div>
        <div className="stat-value">{value}</div>
        {hint && <div className="stat-hint">{hint}</div>}
      </div>
    </div>
  );
}

/** A row of stat tiles that wraps on narrow screens. */
export function StatRow({ children }: { children: ReactNode }) {
  return <div className="stat-row">{children}</div>;
}
