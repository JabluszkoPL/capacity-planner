import { useMemo, useState } from "react";
import { NavLink } from "react-router-dom";
import { isJiraConfigured } from "../../lib/jiraSettings";
import { useJiraSettings } from "../../lib/useJiraSettings";
import { createJiraTransport } from "../../lib/jiraTransport";
import { JiraSettingsPanel } from "../tracking/JiraSettingsPanel";
import { APP_VERSION } from "../../lib/appInfo";
import { useUpdates } from "../../lib/updates";
import { AboutPanel } from "./AboutPanel";
import "./layout.css";

/**
 * The version, and the way into updates and sharing. Quiet until there is
 * something to say: then it becomes the one coloured thing in the header.
 */
function VersionButton({ onOpen }: { onOpen: () => void }) {
  const { state } = useUpdates();
  const pending =
    state.status === "available" ||
    state.status === "downloading" ||
    state.status === "ready";
  const label =
    state.status === "ready"
      ? "Restart to update"
      : state.status === "downloading"
        ? `Updating… ${Math.round((state.progress ?? 0) * 100)}%`
        : state.status === "available" && state.latest
          ? `Update to v${state.latest.version}`
          : `v${APP_VERSION}`;
  return (
    <button
      type="button"
      className={"nav-btn version-btn" + (pending ? " update-pending" : "")}
      onClick={onOpen}
      aria-label={`${label}. About Planner, updates, sharing and backup`}
      title="About Planner, updates, sharing and backup"
    >
      {pending && <span aria-hidden="true">⬆︎</span>}
      {label}
    </button>
  );
}

export function Header() {
  const settings = useJiraSettings();
  const connected = isJiraConfigured(settings);
  const [jiraOpen, setJiraOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);

  // One transport per mount, same reasoning as useTrackerRefresh: it holds no
  // state, but a fresh one every render would break memoisation downstream.
  const transport = useMemo(() => createJiraTransport(), []);

  return (
    <header className="app-header">
      <div className="brand">🗂️ Planner</div>
      <nav className="tabs">
        <NavLink
          to="/"
          end
          className={({ isActive }) => "nav-btn" + (isActive ? " active" : "")}
        >
          <span aria-hidden="true">📁</span> Projects
        </NavLink>
        <NavLink
          to="/team"
          className={({ isActive }) => "nav-btn" + (isActive ? " active" : "")}
        >
          <span aria-hidden="true">👥</span> Teams
        </NavLink>
        <NavLink
          to="/tracking"
          className={({ isActive }) => "nav-btn" + (isActive ? " active" : "")}
        >
          <span aria-hidden="true">📊</span> Tracking
        </NavLink>
      </nav>
      <div className="header-right">
        <VersionButton onOpen={() => setAboutOpen(true)} />
        <button
          type="button"
          className="nav-btn jira-nav-btn"
          onClick={() => setJiraOpen(true)}
          title={
            connected
              ? `Jira: ${settings.email} @ ${settings.baseUrl.replace(/^https?:\/\//, "")}`
              : "Jira is not connected"
          }
        >
          <span
            className={"jira-dot" + (connected ? " connected" : "")}
            aria-hidden="true"
          />
          <span aria-hidden="true">🔌</span> Jira
        </button>
      </div>

      <AboutPanel open={aboutOpen} onClose={() => setAboutOpen(false)} />
      <JiraSettingsPanel
        open={jiraOpen}
        onClose={() => setJiraOpen(false)}
        settings={settings}
        transport={transport}
      />
    </header>
  );
}
