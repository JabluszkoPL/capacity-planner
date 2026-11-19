import { useSyncExternalStore } from "react";
import {
  readJiraSettings,
  subscribeJiraSettings,
  type JiraSettings,
} from "./jiraSettings";

/**
 * The current Jira settings, re-read whenever they change.
 *
 * `useSyncExternalStore` rather than an effect because several unrelated
 * panels read this — the header summary, the settings modal, every tracker's
 * refresh button — and they must never disagree about whether Jira is
 * configured.
 *
 * The parsed value is cached because the hook's contract requires a stable
 * reference between changes: re-parsing the stored JSON on every render would
 * hand React a fresh object each time and re-render forever.
 */
let cached: JiraSettings | null = null;

/**
 * Invalidation is wired up once at module load, NOT inside `subscribe`.
 *
 * Subscribing per-component looks equivalent and is not: settings can be
 * written while nothing is mounted (a test, or a save from a panel that
 * unmounts as it closes), and with no subscriber there would be nobody to
 * clear the cache — leaving every later reader with the settings as they were
 * before the write.
 */
subscribeJiraSettings(() => {
  cached = null;
});

function snapshot(): JiraSettings {
  if (cached === null) cached = readJiraSettings();
  return cached;
}

export function useJiraSettings(): JiraSettings {
  return useSyncExternalStore(subscribeJiraSettings, snapshot, snapshot);
}
