import type { UnassignedTask } from "@planner/core";

interface UnassignedCalloutProps {
  unassigned: UnassignedTask[];
}

export function UnassignedCallout({ unassigned }: UnassignedCalloutProps) {
  if (unassigned.length === 0) return null;
  return (
    <div className="callout warn" role="status">
      <strong>
        {unassigned.length} task{unassigned.length === 1 ? "" : "s"} could not
        be scheduled:
      </strong>
      <ul>
        {unassigned.map((t) => (
          <li key={t.id}>
            {t.epicName} / {t.name} — {t.reason}
          </li>
        ))}
      </ul>
    </div>
  );
}
