import { useEffect, useMemo, useState } from "react";
import type { JiraSnapshot, SprintDraftItem } from "@planner/core";
import type { SprintItemApplied } from "@planner/client-runtime";
import { applyDates, basicAuth, dateChanges } from "@planner/jira";
import type { WriteResult, WriteSpan } from "@planner/jira";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { useToast } from "../ui/Toast";
import type { JiraSettings } from "../../lib/jiraSettings";
import type { AppJiraTransport } from "../../lib/jiraTransport";

interface WritebackModalProps {
  open: boolean;
  onClose: () => void;
  /** The draft's rows, in the order the planner shows them. */
  items: readonly SprintDraftItem[];
  /** Each row's scheduled span, keyed by issue key (a `DraftSpan` fits). */
  spans: ReadonlyMap<string, WriteSpan>;
  /** What Jira last said — the "before" half of the preview, and the field
   *  ids the write must use. */
  snapshot: JiraSnapshot;
  /** The tracker's own Jira site; credentials come from `settings`. */
  baseUrl: string;
  settings: JiraSettings;
  transport: AppJiraTransport;
  /** Called once, with only the issues Jira accepted. */
  onApplied: (applied: SprintItemApplied[]) => void;
}

/** An unset Jira date, shown as an em dash rather than an empty cell. */
function dateCell(value: string | undefined): string {
  return value && value.length > 0 ? value : "—";
}

function countLine(n: number): string {
  if (n === 0) return "Nothing to write — Jira already has these dates.";
  if (n === 1) return "1 issue will get new dates in Jira.";
  return `${n} issues will get new dates in Jira.`;
}

/**
 * The confirmation step in front of the only write Planner ever makes.
 *
 * Three deliberate frictions, because this edits other people's tickets:
 *
 * - The table shows *both* sides of every date, so "what will change" is a
 *   thing you read rather than a thing you trust. Rows that would not change
 *   never reach here — `dateChanges()` drops them upstream.
 * - Apply stays disabled until the review checkbox is ticked. The dialog opens
 *   one keystroke away from a button that rewrites thirty due dates; a tick is
 *   a cheap way to make that a decision.
 * - Afterwards the table is *replaced* by the per-issue outcome. A partial
 *   failure is the normal case (one issue in a project the account cannot
 *   edit), and the preview would otherwise still be claiming all thirty moved.
 *
 * Only the successes are handed to `onApplied`; a failed issue keeps whatever
 * Jira had, so stamping it as applied would make the draft lie.
 */
export function WritebackModal({
  open,
  onClose,
  items,
  spans,
  snapshot,
  baseUrl,
  settings,
  transport,
  onApplied,
}: WritebackModalProps) {
  const toast = useToast();
  const [reviewed, setReviewed] = useState(false);
  const [applying, setApplying] = useState(false);
  const [results, setResults] = useState<WriteResult[] | null>(null);

  // One list serves the preview and the requests, so what was reviewed is
  // exactly what is sent — including the rows dropped for changing nothing.
  const changes = useMemo(
    () => dateChanges(items, spans, snapshot),
    [items, spans, snapshot],
  );

  // Each opening is a fresh decision: a previous run's results and a previous
  // run's tick must never carry over into the next one.
  useEffect(() => {
    if (!open) return;
    setReviewed(false);
    setApplying(false);
    setResults(null);
  }, [open]);

  async function apply() {
    setApplying(true);
    try {
      const written = await applyDates(transport, {
        baseUrl,
        auth: basicAuth(settings.email, settings.apiToken),
        changes,
        fieldIds: snapshot.fieldIds,
      });
      setResults(written);

      const at = new Date().toISOString();
      const byKey = new Map(changes.map((c) => [c.issueKey, c]));
      const applied: SprintItemApplied[] = [];
      for (const result of written) {
        const change = byKey.get(result.issueKey);
        if (!result.ok || !change) continue;
        applied.push({
          issueKey: result.issueKey,
          at,
          startDate: change.nextStart,
          dueDate: change.nextDue,
        });
      }
      onApplied(applied);

      const failed = written.length - applied.length;
      toast(
        failed === 0
          ? `Updated ${applied.length} in Jira`
          : `Updated ${applied.length}, ${failed} failed`,
      );
    } catch (err) {
      // applyDates only throws when it never started — a transport that
      // refuses writes. Nothing was sent, so the preview stays put.
      toast(err instanceof Error ? err.message : "Could not write to Jira");
    } finally {
      setApplying(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Apply dates to Jira">
      <div className="writeback">
        {results === null ? (
          <>
            <p className="writeback-summary">{countLine(changes.length)}</p>

            {changes.length > 0 && (
              <div className="writeback-scroll">
                <table className="writeback-table">
                  <thead>
                    <tr>
                      <th scope="col">Issue</th>
                      <th scope="col">Summary</th>
                      <th scope="col">Start</th>
                      <th scope="col">Due</th>
                    </tr>
                  </thead>
                  <tbody>
                    {changes.map((c) => (
                      <tr key={c.issueKey}>
                        <th scope="row">{c.issueKey}</th>
                        <td>{c.summary}</td>
                        <td>
                          <span className="writeback-from">
                            {dateCell(c.currentStart)}
                          </span>{" "}
                          → {c.nextStart}
                        </td>
                        <td>
                          <span className="writeback-from">
                            {dateCell(c.currentDue)}
                          </span>{" "}
                          → {c.nextDue}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <label className="writeback-review">
              <input
                type="checkbox"
                checked={reviewed}
                onChange={(e) => setReviewed(e.target.checked)}
              />
              <span>I reviewed these changes</span>
            </label>

            <p className="muted">
              Only start and due dates are written. Assignees, estimates and
              sprints in Jira are left alone.
            </p>

            <div className="modal-actions">
              <span className="spacer" />
              <Button onClick={onClose}>Cancel</Button>
              <Button
                variant="primary"
                disabled={!reviewed || applying || changes.length === 0}
                onClick={apply}
              >
                {applying ? "Applying…" : "Apply to Jira"}
              </Button>
            </div>
          </>
        ) : (
          <>
            <ul className="writeback-results" role="status">
              {results.map((r) => (
                <li
                  key={r.issueKey}
                  className={`writeback-result ${r.ok ? "ok" : "failed"}`}
                >
                  <span className="writeback-glyph" aria-hidden="true">
                    {r.ok ? "✓" : "✕"}
                  </span>
                  <span className="writeback-key">{r.issueKey}</span>
                  <span>
                    {r.ok
                      ? "Updated"
                      : `Failed — ${r.error ?? "unknown error"}`}
                  </span>
                </li>
              ))}
            </ul>

            <div className="modal-actions">
              <span className="spacer" />
              <Button variant="primary" onClick={onClose}>
                Close
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
