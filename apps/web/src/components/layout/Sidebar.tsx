import { useMemo, useState } from "react";
import { Link, matchPath, useLocation } from "react-router-dom";
import { useAppStore } from "@planner/client-runtime";
import type { SyncStatus } from "@planner/client-runtime";
import { isJiraConfigured } from "../../lib/jiraSettings";
import { useJiraSettings } from "../../lib/useJiraSettings";
import { createJiraTransport } from "../../lib/jiraTransport";
import { JiraSettingsPanel } from "../tracking/JiraSettingsPanel";
import { APP_VERSION } from "../../lib/appInfo";
import { useUpdates } from "../../lib/updates";
import { Icon, type IconName } from "../ui/Icon";
import { AboutPanel } from "./AboutPanel";
import "./layout.css";

/**
 * The app's navigation between sections. There is no top bar: the brand, the
 * three sections and the device's status (sync, Jira, settings and version)
 * live here. A page with several views (a project, a tracker) shows them as
 * tabs under its own header (ui/ViewTabs).
 */
export function Sidebar() {
  const { pathname } = useLocation();
  const projectMatch = matchPath("/project/:id", pathname);

  return (
    <aside className="sidebar" aria-label="Sidebar">
      <div className="sidebar-brand">
        <Icon name="leaf" size={18} className="sidebar-brand-icon" />
        <span>Planner</span>
      </div>

      <nav className="sidebar-nav" aria-label="Main">
        <SectionLink
          to="/"
          icon="folder"
          label="Projects"
          active={pathname === "/" || !!projectMatch}
        />
        <SectionLink
          to="/team"
          icon="users"
          label="Teams"
          active={pathname.startsWith("/team")}
        />
        <SectionLink
          to="/tracking"
          icon="activity"
          label="Tracking"
          active={pathname.startsWith("/tracking")}
        />
      </nav>

      <div className="sidebar-spacer" />
      <SidebarFooter />
    </aside>
  );
}

function SectionLink({
  to,
  icon,
  label,
  active,
}: {
  to: string;
  icon: IconName;
  label: string;
  active: boolean;
}) {
  return (
    <Link
      to={to}
      className={"sidebar-link" + (active ? " active" : "")}
      aria-current={active ? "page" : undefined}
    >
      <Icon name={icon} size={17} />
      <span>{label}</span>
    </Link>
  );
}

const SYNC_LABEL: Record<SyncStatus, string> = {
  offline: "Offline",
  connecting: "Connecting…",
  syncing: "Syncing…",
  live: "Synced",
  incompatible: "Sync blocked",
};

function SidebarFooter() {
  const { syncStatus, syncEnabled } = useAppStore();
  const settings = useJiraSettings();
  const connected = isJiraConfigured(settings);
  const [jiraOpen, setJiraOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  // One transport per mount: it holds no state, but a fresh one every render
  // would break memoisation downstream.
  const transport = useMemo(() => createJiraTransport(), []);

  const syncLabel = syncEnabled ? SYNC_LABEL[syncStatus] : "Local only";
  const syncTone = !syncEnabled
    ? "local"
    : syncStatus === "live"
      ? "ok"
      : syncStatus === "incompatible"
        ? "bad"
        : "pending";

  return (
    <div className="sidebar-footer">
      <div
        className={`sidebar-status sync-${syncTone}`}
        title={
          syncEnabled
            ? `Sync: ${syncLabel}`
            : "This device keeps its own copy; no sync server is set"
        }
      >
        <Icon
          name={syncEnabled && syncStatus === "live" ? "cloud" : "cloudOff"}
          size={15}
        />
        <span>{syncLabel}</span>
        <span className="sync-dot" aria-hidden="true" />
      </div>
      <button
        type="button"
        className="sidebar-link sidebar-footer-btn"
        onClick={() => setJiraOpen(true)}
        title={
          connected
            ? `Jira: ${settings.email} @ ${settings.baseUrl.replace(/^https?:\/\//, "")}`
            : "Jira is not connected"
        }
      >
        <Icon name="plug" size={16} />
        <span>Jira</span>
        <span
          className={"jira-dot" + (connected ? " connected" : "")}
          aria-hidden="true"
        />
      </button>
      <VersionButton onOpen={() => setAboutOpen(true)} />

      <AboutPanel
        open={aboutOpen}
        onClose={() => setAboutOpen(false)}
        onOpenJira={() => {
          setAboutOpen(false);
          setJiraOpen(true);
        }}
      />
      <JiraSettingsPanel
        open={jiraOpen}
        onClose={() => setJiraOpen(false)}
        settings={settings}
        transport={transport}
      />
    </div>
  );
}

/**
 * The version, and the way into settings, updates, sharing and backup. Quiet
 * until there is something to say: then it becomes the accent-coloured thing.
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
      className={
        "sidebar-link sidebar-footer-btn version-btn" +
        (pending ? " update-pending" : "")
      }
      onClick={onOpen}
      aria-label={`${label}. Settings and About Planner: updates, sharing and backup`}
      title="Settings, updates, sharing and backup"
    >
      <Icon name={pending ? "download" : "settings"} size={16} />
      <span>Settings</span>
      <span className="version-label">{label}</span>
    </button>
  );
}
