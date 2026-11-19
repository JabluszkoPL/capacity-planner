import type { TeamMember } from "@planner/core";
import { EmptyState } from "../ui/EmptyState";
import { MemberChip } from "./MemberChip";

interface MemberListProps {
  members: TeamMember[];
}

export function MemberList({ members }: MemberListProps) {
  if (members.length === 0) {
    return (
      <EmptyState
        compact
        title="No team members yet"
        message="Add your first team member below."
      />
    );
  }
  return (
    <div className="member-list">
      {members.map((m) => (
        <MemberChip key={m.id} member={m} />
      ))}
    </div>
  );
}
