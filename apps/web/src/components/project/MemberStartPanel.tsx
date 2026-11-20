import { useState } from "react";
import {
  type Project,
  allMembers,
  includedMembers,
  colorFor,
  findMemberTeam,
} from "@planner/core";
import { useAppStore } from "@planner/client-runtime";

import { IconButton } from "../ui/IconButton";
import { EmptyState } from "../ui/EmptyState";
import { Panel } from "../ui/Panel";
import { Icon } from "../ui/Icon";
import { Avatar } from "../ui/IconTile";
import { ColorTag } from "../ui/Badge";

import "./helpers.css";

interface MemberStartPanelProps {
  project: Project;
}

/**
 * Per-project start-date overrides for team members. By default everyone
 * starts on the project start date; set a later date for anyone who only
 * joins this project part-way through.
 */
export function MemberStartPanel({ project }: MemberStartPanelProps) {
  const { state, actions } = useAppStore();
  const members = includedMembers(project, state.teams);
  const noTeamsAtAll = allMembers(state.teams).length === 0;
  const starts = project.memberStarts ?? {};
  const overrideCount = Object.keys(starts).length;

  // Collapsed by default: a per-member override is the exception, not the
  // rule, so the full list shouldn't dominate the page until someone opens it.
  const [collapsed, setCollapsed] = useState(true);

  return (
    <Panel
      className={"member-start-panel" + (collapsed ? " is-collapsed" : "")}
      title="Team start dates"
      subtitle={
        overrideCount > 0
          ? `${overrideCount} override${overrideCount === 1 ? "" : "s"}`
          : "Everyone starts with the project"
      }
      actions={
        <IconButton
          label={
            collapsed ? "Expand team start dates" : "Collapse team start dates"
          }
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((c) => !c)}
        >
          <Icon name={collapsed ? "chevronRight" : "chevronDown"} size={16} />
        </IconButton>
      }
      flush={!collapsed && members.length > 0}
    >
      {collapsed ? null : (
        <>
          <p className="muted helpers-intro">
            Everyone starts on the project start date ({project.startDate})
            unless you set a later date here. Useful when someone only joins
            this project part-way through.
          </p>

          {members.length === 0 ? (
            noTeamsAtAll ? (
              <EmptyState
                compact
                title="No team members"
                message="Add team members on the Team page to set their start dates here."
              />
            ) : (
              <EmptyState
                compact
                title="No teams selected"
                message="Select a team under “Teams on this project” to set start dates for its members."
              />
            )
          ) : (
            <table className="data-table member-start-table">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Team</th>
                  <th>Specialization</th>
                  <th>Starts</th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => {
                  const value = starts[m.id] ?? "";
                  return (
                    <tr key={m.id}>
                      <td>
                        <span className="member-start-name">
                          <Avatar
                            name={m.name}
                            color={colorFor(m.specialization)}
                            size="sm"
                          />
                          {m.name}
                        </span>
                      </td>
                      <td className="muted">
                        {findMemberTeam(state.teams, m.id)?.name ?? ""}
                      </td>
                      <td>
                        {m.specialization ? (
                          <ColorTag color={colorFor(m.specialization)}>
                            {m.specialization}
                          </ColorTag>
                        ) : (
                          <span className="muted">-</span>
                        )}
                      </td>
                      <td>
                        <span className="member-start-date">
                          <input
                            type="date"
                            aria-label={`Start date for ${m.name}`}
                            min={project.startDate}
                            value={value}
                            onChange={(e) =>
                              actions.setMemberStart(
                                project.id,
                                m.id,
                                e.target.value || null,
                              )
                            }
                          />
                          {value ? (
                            <IconButton
                              label={`Clear start date for ${m.name}`}
                              onClick={() =>
                                actions.setMemberStart(project.id, m.id, null)
                              }
                            >
                              <Icon name="x" size={14} />
                            </IconButton>
                          ) : (
                            <span className="member-start-default">
                              from start
                            </span>
                          )}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </>
      )}
    </Panel>
  );
}
