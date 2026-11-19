import { useCallback, useMemo, useState } from "react";
import { todayISO, type Tracker } from "@planner/core";
import { useAppStore } from "@planner/client-runtime";
import { useToast } from "../ui/Toast";
import { createJiraTransport } from "../../lib/jiraTransport";
import { useJiraSettings } from "../../lib/useJiraSettings";
import { refreshTracker } from "../../lib/refreshTracker";
import { readTagAliases } from "../../lib/tagAliases";

/**
 * Refreshing, shared by the list page and a single tracker.
 *
 * Both entry points must behave identically — same request, same failure
 * wording, same "the old snapshot survives a failure" rule — so the behaviour
 * lives here rather than being written twice and drifting.
 */
export function useTrackerRefresh() {
  const { state, actions } = useAppStore();
  const settings = useJiraSettings();
  const toast = useToast();
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());

  // One transport per mount: it holds no state, but rebuilding it on every
  // render would mean a new identity in every dependency array below it.
  const transport = useMemo(() => createJiraTransport(), []);

  const refresh = useCallback(
    async (tracker: Tracker, options: { quiet?: boolean } = {}) => {
      setBusyIds((prev) => new Set(prev).add(tracker.id));
      try {
        const result = await refreshTracker({
          tracker,
          settings,
          transport,
          state,
          today: todayISO(),
          now: new Date().toISOString(),
          tagAliases: readTagAliases(),
        });
        if (result.ok) {
          if (result.mapping) {
            actions.setTrackerTaskMap(tracker.id, result.mapping.taskMap);
            actions.setTrackerAddedScope(tracker.id, result.mapping.addedScope);
          }
          actions.setTrackerSnapshot(
            tracker.id,
            result.snapshot,
            result.sample,
          );
          if (!options.quiet) {
            toast(`${tracker.initiativeKey} refreshed`);
          }
        } else if (!options.quiet) {
          // Copied to the clipboard alongside a longer-lived toast, so the
          // failure can be pasted straight into a message to whoever needs
          // to see it (a Jira admin, a bug report) without retyping it.
          const context = [
            `Tracker: ${tracker.initiativeKey}`,
            `Failure: ${result.kind}`,
            `Jira: ${tracker.baseUrl || settings.baseUrl}`,
            `Refresh: ${transport.description}`,
            `At: ${new Date().toISOString()}`,
          ].join("\n");
          toast(result.message, { isError: true, context });
        }
        return result;
      } finally {
        setBusyIds((prev) => {
          const next = new Set(prev);
          next.delete(tracker.id);
          return next;
        });
      }
    },
    [actions, settings, state, toast, transport],
  );

  return { refresh, busyIds, transport, settings };
}
