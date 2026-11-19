import { useEffect, useState, type KeyboardEvent } from "react";
import { type TeamMember, colorFor } from "@planner/core";
import { useAppStore } from "@planner/client-runtime";
import { useConfirm } from "../ui/ConfirmDialog";
import { IconButton } from "../ui/IconButton";

interface MemberChipProps {
  member: TeamMember;
}

function blurOnEnter(e: KeyboardEvent<HTMLInputElement>) {
  if (e.key === "Enter") {
    e.preventDefault();
    e.currentTarget.blur();
  }
}

export function MemberChip({ member }: MemberChipProps) {
  const { actions } = useAppStore();
  const confirm = useConfirm();

  const [name, setName] = useState(member.name);
  const [spec, setSpec] = useState(member.specialization);
  useEffect(() => setName(member.name), [member.name]);
  useEffect(() => setSpec(member.specialization), [member.specialization]);

  const commitName = () => {
    const next = name.trim();
    if (!next) {
      setName(member.name); // don't allow a blank member name
      return;
    }
    if (next !== member.name) actions.editTeamMember(member.id, { name: next });
  };
  const commitSpec = () => {
    const next = spec.trim();
    if (next !== member.specialization)
      actions.editTeamMember(member.id, { specialization: next });
  };

  const handleDelete = async () => {
    const ok = await confirm({
      title: "Remove team member",
      message: `Remove ${member.name} from the team? Their marked days off will be removed too.`,
      confirmLabel: "Remove",
      danger: true,
    });
    if (ok) actions.deleteTeamMember(member.id);
  };

  return (
    <div className="member-chip">
      <span
        className="swatch"
        style={{ background: colorFor(member.specialization) }}
        aria-hidden="true"
      />
      <input
        type="text"
        className="m-name"
        aria-label="Member name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={commitName}
        onKeyDown={blurOnEnter}
      />
      <input
        type="text"
        className="m-spec"
        list="spec-list"
        aria-label="Member specialization"
        placeholder="e.g. Frontend"
        value={spec}
        onChange={(e) => setSpec(e.target.value)}
        onBlur={commitSpec}
        onKeyDown={blurOnEnter}
      />
      <label className="m-speed-label" title="Work speed (1 = at estimate)">
        <span aria-hidden="true">×</span>
        <input
          type="number"
          className="m-speed"
          aria-label="Member speed"
          min="0.1"
          step="0.1"
          value={member.speed ?? 1}
          onChange={(e) => {
            const v = Number(e.target.value);
            actions.editTeamMember(member.id, {
              speed: Number.isFinite(v) && v > 0 ? v : 1,
            });
          }}
        />
      </label>
      <IconButton danger label={`Remove ${member.name}`} onClick={handleDelete}>
        ✕
      </IconButton>
    </div>
  );
}
