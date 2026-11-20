import type { OffDayMap, TeamMember } from "@planner/core";
import { EmptyState } from "../ui/EmptyState";
import { MemberRow } from "./MemberRow";

interface MemberListProps {
  members: TeamMember[];
  /** The team's days off, for each person's "next day off" column. */
  offDays?: OffDayMap;
}

/** A team's roster: one editable row per person. */
export function MemberList({ members, offDays = {} }: MemberListProps) {
  if (members.length === 0) {
    return (
      <div className="roster-empty">
        <EmptyState
          compact
          title="No team members yet"
          message="Add your first team member below."
        />
      </div>
    );
  }
  return (
    <div className="roster-scroll">
      <table className="data-table roster-table">
        <thead>
          <tr>
            <th scope="col">Person</th>
            <th scope="col">Specialization</th>
            <th scope="col" className="num" title="1 = works at estimate">
              Speed
            </th>
            <th scope="col">Next day off</th>
            <th scope="col" className="roster-actions" aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <MemberRow key={m.id} member={m} offDays={offDays[m.id] ?? []} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
