import { useEffect, useState } from "react";
import type { EstimateUpdate } from "@planner/jira";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { Badge } from "../ui/Badge";
import { days } from "./StatusPanel";

interface EstimateUpdateModalProps {
  open: boolean;
  onClose: () => void;
  /** The baseline project's name, so it is clear what gets edited. */
  projectName: string;
  /** From `estimateUpdates()`: only tasks that would actually change. */
  updates: readonly EstimateUpdate[];
  /** Called once, with only the rows left ticked. */
  onApply: (chosen: EstimateUpdate[]) => void;
}

function baselineCell(u: EstimateUpdate): string {
  return u.currentExcluded
    ? `${days(u.currentDays)} d, skipped`
    : `${days(u.currentDays)} d`;
}

/**
 * The confirmation in front of copying Jira estimates into the baseline.
 *
 * A refresh never does this on its own: the baseline is what the tracker
 * measures against, so every change here moves the plan's dates and the
 * reading with them. Each row starts ticked, because a refresh that found new
 * estimates is usually the reason the dialog was opened; untick the ones the
 * plan should keep.
 */
export function EstimateUpdateModal({
  open,
  onClose,
  projectName,
  updates,
  onApply,
}: EstimateUpdateModalProps) {
  const [chosen, setChosen] = useState<Set<string>>(() => new Set());

  // Each opening is a fresh decision, with every current row ticked.
  useEffect(() => {
    if (open) setChosen(new Set(updates.map((u) => u.taskId)));
    // Only on opening: a re-render must not re-tick what was just unticked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const toggle = (taskId: string) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });

  const selected = updates.filter((u) => chosen.has(u.taskId));

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Update estimates from Jira"
      className="tracking-dialog"
      subtitle={
        updates.length === 0
          ? undefined
          : `Review and confirm: ${selected.length} of ${updates.length} selected`
      }
    >
      <div className="writeback">
        <p className="writeback-summary">
          {updates.length === 0
            ? "The baseline already has Jira's estimates."
            : `${updates.length} task${updates.length === 1 ? "" : "s"} in ${projectName} ${updates.length === 1 ? "has" : "have"} a different estimate in Jira.`}
        </p>

        {updates.length > 0 && (
          <div className="writeback-scroll">
            <table className="data-table writeback-table">
              <thead>
                <tr>
                  <th scope="col" className="writeback-check">
                    <input
                      type="checkbox"
                      aria-label="Copy every Jira estimate"
                      checked={selected.length === updates.length}
                      ref={(el) => {
                        if (el)
                          el.indeterminate =
                            selected.length > 0 &&
                            selected.length < updates.length;
                      }}
                      onChange={(e) =>
                        setChosen(
                          e.target.checked
                            ? new Set(updates.map((u) => u.taskId))
                            : new Set(),
                        )
                      }
                    />
                  </th>
                  <th scope="col">Plan task</th>
                  <th scope="col">Jira</th>
                  <th scope="col">Old → New</th>
                  <th scope="col" className="num">
                    Change
                  </th>
                </tr>
              </thead>
              <tbody>
                {updates.map((u) => {
                  const delta =
                    u.jiraDays - (u.currentExcluded ? 0 : u.currentDays);
                  return (
                    <tr
                      key={u.taskId}
                      className={chosen.has(u.taskId) ? undefined : "unchosen"}
                    >
                      <td className="writeback-check">
                        <input
                          type="checkbox"
                          aria-label={`Copy the Jira estimate to ${u.taskName}`}
                          checked={chosen.has(u.taskId)}
                          onChange={() => toggle(u.taskId)}
                        />
                      </td>
                      <td>
                        {u.taskName}
                        <span className="muted"> · {u.epicName}</span>
                      </td>
                      <td className="writeback-key">
                        {u.issueKeys.join(", ")}
                      </td>
                      <td className="writeback-change">
                        <span className="writeback-from">
                          {baselineCell(u)}
                        </span>{" "}
                        → {days(u.jiraDays)} d
                      </td>
                      <td className="num">
                        <Badge
                          tone={
                            u.currentExcluded
                              ? "info"
                              : delta > 0
                                ? "warning"
                                : "success"
                          }
                        >
                          {u.currentExcluded
                            ? "Un-skip"
                            : `${delta > 0 ? "+" : "−"}${days(Math.abs(delta))} d`}
                        </Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <p className="muted">
          This edits the baseline project in Planner, not Jira. A skipped task
          is un-skipped. The plan&apos;s dates move with the new estimates, and
          the tracker measures against them from now on.
        </p>

        <div className="modal-actions">
          <span className="spacer" />
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={selected.length === 0}
            onClick={() => onApply(selected)}
          >
            {selected.length === 1
              ? "Update 1 task"
              : `Update ${selected.length} tasks`}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
