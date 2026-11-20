import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { todayISO } from "@planner/core";
import { useAppStore } from "@planner/client-runtime";
import { useConfirm } from "../components/ui/ConfirmDialog";
import { useToast } from "../components/ui/Toast";
import { Button, EmptyState, Page, PageHeader, Panel } from "../components/ui";
import { AddTrackerForm } from "../components/tracking/AddTrackerForm";
import { JiraSettingsPanel } from "../components/tracking/JiraSettingsPanel";
import { TrackerRow } from "../components/tracking/TrackerCard";
import { useTrackerRefresh } from "../components/tracking/useTrackerRefresh";
import { isJiraConfigured } from "../lib/jiraSettings";
import "../components/tracking/tracking.css";

/** "Tracking - portfolio": every tracked initiative, one row each. */
export function TrackingPage() {
  const { state, actions } = useAppStore();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const toast = useToast();
  const { refresh, busyIds, transport, settings } = useTrackerRefresh();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [adding, setAdding] = useState(false);

  const trackers = state.trackers ?? [];
  const connected = isJiraConfigured(settings);
  const now = new Date().toISOString();
  const today = todayISO();
  // With nothing tracked yet, the form is the page's whole point.
  const showForm = adding || trackers.length === 0;

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
    <Page className="tracking-page">
      <PageHeader
        title="Tracking"
        subtitle={
          <span className="jira-conn-line">
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
          </span>
        }
        actions={
          <>
            {trackers.length > 0 && (
              <Button
                icon="refresh"
                onClick={refreshAll}
                disabled={refreshingAll || !connected}
              >
                {refreshingAll ? "Refreshing all…" : "Refresh all"}
              </Button>
            )}
            {trackers.length > 0 && (
              <Button
                variant="primary"
                icon="plus"
                aria-expanded={adding}
                aria-controls="add-tracker-form"
                onClick={() => setAdding(!adding)}
              >
                Add tracker
              </Button>
            )}
          </>
        }
      />

      {showForm && (
        <AddTrackerForm
          id="add-tracker-form"
          fallbackBaseUrl={settings.baseUrl}
          onAdd={add}
          autoFocus={adding}
          onCancel={trackers.length > 0 ? () => setAdding(false) : undefined}
        />
      )}

      {trackers.length === 0 ? (
        <EmptyState
          title="No trackers yet"
          message="Paste a Jira initiative link above to compare what is actually happening with one of your plans."
        />
      ) : (
        <Panel flush className="tracker-portfolio">
          <div className="table-scroll">
            <table className="data-table tracker-table">
              <thead>
                <tr>
                  <th scope="col">Tracker</th>
                  <th scope="col">Project (baseline)</th>
                  <th scope="col">Health</th>
                  <th scope="col">Last refreshed</th>
                  <th scope="col" className="num">
                    Buffer remaining
                  </th>
                  <th scope="col">Forecast finish</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {trackers.map((tracker) => (
                  <TrackerRow
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
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      <JiraSettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        transport={transport}
      />
    </Page>
  );
}
