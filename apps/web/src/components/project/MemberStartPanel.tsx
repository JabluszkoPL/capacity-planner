import { useState } from "react";
import {
  type Project,
  allMembers,
  includedMembers,
  colorFor,
} from "@planner/core";
import { useAppStore } from "@planner/client-runtime";

import { IconButton } from "../ui/IconButton";
import { EmptyState } from "../ui/EmptyState";

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
    <section className="helpers-panel">
      <div className="section-head">
        <IconButton
          label={
            collapsed ? "Expand team start dates" : "Collapse team start dates"
          }
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((c) => !c)}
        >
          {collapsed ? "▸" : "▾"}
        </IconButton>
        <h2 className="section-title">Team start dates</h2>
        {overrideCount > 0 && (
          <span className="muted">
            {overrideCount} override{overrideCount === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {!collapsed && (
        <>
          <p className="muted helpers-intro">
            Everyone starts on the project start date ({project.startDate})
            unless you set a later date here — useful when someone only joins
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
            <div className="member-start-list">
              {members.map((m) => {
                const value = starts[m.id] ?? "";
                return (
                  <div className="member-start-row" key={m.id}>
                    <span className="member-start-name">
                      <span
                        className="swatch"
                        style={{ background: colorFor(m.specialization) }}
                        aria-hidden="true"
                      />
                      {m.name}
                      <span className="spec-tag">
                        {m.specialization || "—"}
                      </span>
                    </span>
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
                        ✕
                      </IconButton>
                    ) : (
                      <span className="member-start-default">from start</span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </section>
  );
}
