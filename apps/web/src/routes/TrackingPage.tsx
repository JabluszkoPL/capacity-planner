import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { todayISO } from "@planner/core";
import { useAppStore } from "@planner/client-runtime";
import { useConfirm } from "../components/ui/ConfirmDialog";
import { useToast } from "../components/ui/Toast";
import { EmptyState } from "../components/ui/EmptyState";
import { Button } from "../components/ui/Button";
import { AddTrackerForm } from "../components/tracking/AddTrackerForm";
import { JiraSettingsPanel } from "../components/tracking/JiraSettingsPanel";
import { TrackerCard } from "../components/tracking/TrackerCard";
import { useTrackerRefresh } from "../components/tracking/useTrackerRefresh";
import { isJiraConfigured } from "../lib/jiraSettings";
import "../components/tracking/tracking.css";

export function TrackingPage() {
  const { state, actions } = useAppStore();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const toast = useToast();
  const { refresh, busyIds, transport, settings } = useTrackerRefresh();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [refreshingAll, setRefreshingAll] = useState(false);

  const trackers = state.trackers ?? [];
  const connected = isJiraConfigured(settings);
  const now = new Date().toISOString();
  const today = todayISO();

  function add(link: { url: string; key: string; baseUrl: string }) {
    const id = actions.createTracker(
      link.key,
      link.url,
      link.key,
      link.baseUrl,
    );
    navigate(`/tracking/${id}`);
  }

  async function remove(id: string) {
    const tracker = trackers.find((t) => t.id === id);
    if (!tracker) return;
    const ok = await confirm({
      title: "Delete tracker",
      message: `Stop tracking ${tracker.initiativeKey}? Its refresh history is deleted too.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (ok) actions.deleteTracker(id);
  }

  async function refreshAll() {
    if (trackers.length === 0) return;
    setRefreshingAll(true);
    let ok = 0;
    const failures: string[] = [];
    // Sequentially: Jira rate-limits per account, and a burst of parallel
    // refreshes is the fastest way to get every one of them throttled.
    for (const tracker of trackers) {
      const result = await refresh(tracker, { quiet: true });
      if (result.ok) ok++;
      else failures.push(`${tracker.initiativeKey}: ${result.message}`);
    }
    setRefreshingAll(false);
    if (failures.length === 0) {
      toast(`Refreshed ${ok} tracker${ok === 1 ? "" : "s"}`);
    } else {
      toast(`Refreshed ${ok} of ${trackers.length} — ${failures[0]}`, {
        isError: true,
        context: failures.join("\n"),
      });
    }
  }

  return (
    <main className="page">
      <h1 className="page-title">Tracking</h1>

      <p className="muted jira-conn-line">
        {connected ? (
          <>
            Jira: {settings.email} ·{" "}
            {settings.baseUrl.replace(/^https?:\/\//, "")} · refresh{" "}
            {transport.description}
          </>
        ) : (
          <>Jira is not connected yet.</>
        )}{" "}
        <button
          type="button"
          className="link-btn"
          onClick={() => setSettingsOpen(true)}
        >
          {connected ? "Settings" : "Connect Jira"}
        </button>
      </p>

      <AddTrackerForm fallbackBaseUrl={settings.baseUrl} onAdd={add} />

      {trackers.length === 0 ? (
        <EmptyState
          title="No trackers yet"
          message="Paste a Jira initiative link above to compare what is actually happening with one of your plans."
        />
      ) : (
        <>
          <div className="tracking-toolbar">
            <Button onClick={refreshAll} disabled={refreshingAll || !connected}>
              {refreshingAll ? "Refreshing all…" : "Refresh all"}
            </Button>
          </div>
          <div className="tracker-grid">
            {trackers.map((tracker) => (
              <TrackerCard
                key={tracker.id}
                tracker={tracker}
                state={state}
                today={today}
                now={now}
                busy={busyIds.has(tracker.id)}
                onOpen={(id) => navigate(`/tracking/${id}`)}
                onRefresh={(id) => {
                  const t = trackers.find((x) => x.id === id);
                  if (t) void refresh(t);
                }}
                onDelete={remove}
              />
            ))}
          </div>
        </>
      )}

      <JiraSettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        transport={transport}
      />
    </main>
  );
}
