import type { UnassignedTask } from "@planner/core";
import { Callout } from "../ui/Callout";

interface UnassignedCalloutProps {
  unassigned: UnassignedTask[];
}

export function UnassignedCallout({ unassigned }: UnassignedCalloutProps) {
  if (unassigned.length === 0) return null;
  return (
    <Callout
      tone="warning"
      role="status"
      title={
        <>
          {unassigned.length} task{unassigned.length === 1 ? "" : "s"} could not
          be scheduled:
        </>
      }
    >
      <ul className="unassigned-list">
        {unassigned.map((t) => (
          <li key={t.id}>
            {t.epicName} / {t.name} — {t.reason}
          </li>
        ))}
      </ul>
    </Callout>
  );
}
