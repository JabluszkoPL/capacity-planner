import { useState, type ReactNode } from "react";
import { Segmented } from "../ui/Segmented";

type Mode = "auto" | "manual";

/**
 * The tracker's Sprints view: two ways to plan, one at a time. Automatic cuts
 * the work left into sprints; Manual picks issues for one sprint by hand and
 * can write their dates back to Jira. Without a baseline plan there is
 * nothing for the automatic planner to lay out, so only Manual is shown.
 */
export function SprintSection({
  auto,
  children,
}: {
  /** The automatic planner; absent when it can't run (no baseline). */
  auto?: ReactNode;
  /** The manual planner. */
  children: ReactNode;
}) {
  const [mode, setMode] = useState<Mode>("auto");
  const shown: Mode = auto ? mode : "manual";
  return (
    <section className="sprint-section" aria-label="Sprints">
      {auto && (
        <div className="sprint-section-head">
          <Segmented<Mode>
            label="How to plan sprints"
            value={shown}
            onChange={setMode}
            options={[
              { value: "auto", label: "Automatic" },
              { value: "manual", label: "Manual" },
            ]}
          />
          <span className="muted">
            {shown === "auto"
              ? "Cut the work left into sprints, laid out like the forecast."
              : "Pick issues for one sprint, set their dates, and write them to Jira."}
          </span>
        </div>
      )}
      <div className="sprint-section-body">
        {shown === "auto" ? auto : children}
      </div>
    </section>
  );
}
