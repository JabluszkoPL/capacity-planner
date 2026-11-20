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
 * three sections — each with a list of its projects, teams or trackers that
 * opens under it — and the device's status (sync, Jira, settings and
 * version) live here. A page with several views (a project, a tracker) shows them as
 * tabs under its own header (ui/ViewTabs).
 */
export function Sidebar() {
  const { pathname, search } = useLocation();
  const { state } = useAppStore();
  const projectId = matchPath("/project/:id", pathname)?.params.id;
  const trackerId = matchPath("/tracking/:id", pathname)?.params.id;
  const teamId = pathname.startsWith("/team")
    ? new URLSearchParams(search).get("team")
    : null;
  const [open, toggle] = useOpenSections();

  const sections: SectionDef[] = [
    {
      key: "projects",
      to: "/",
      icon: "folder",
      label: "Projects",
      active: pathname === "/" || !!projectId,
      empty: "No projects yet",
      items: state.projects.map((p) => ({
        id: p.id,
        label: p.name,
        to: `/project/${p.id}`,
        color: p.titleColor ?? undefined,
        active: p.id === projectId,
      })),
    },
    {
      key: "teams",
      to: "/team",
      icon: "users",
      label: "Teams",
      active: pathname.startsWith("/team"),
      empty: "No teams yet",
      items: state.teams.map((t) => ({
        id: t.id,
        label: t.name,
        meta: String(t.members.length),
        metaLabel: `${t.members.length} ${t.members.length === 1 ? "person" : "people"}`,
        to: `/team?team=${encodeURIComponent(t.id)}`,
        active: t.id === teamId,
      })),
    },
    {
      key: "tracking",
      to: "/tracking",
      icon: "activity",
      label: "Tracking",
      active: pathname.startsWith("/tracking"),
      empty: "No trackers yet",
      items: (state.trackers ?? []).map((t) => ({
        id: t.id,
        label: t.name,
        meta: t.initiativeKey,
        to: `/tracking/${t.id}`,
        active: t.id === trackerId,
      })),
    },
  ];

  return (
    <aside className="sidebar" aria-label="Sidebar">
      <div className="sidebar-brand">
        <Icon name="leaf" size={18} className="sidebar-brand-icon" />
        <span>Planner</span>
      </div>

      <nav className="sidebar-nav" aria-label="Main">
        {sections.map((sec) => (
          <SidebarSection
            key={sec.key}
            section={sec}
            open={open[sec.key] ?? sec.active}
            onToggle={() => toggle(sec.key, !(open[sec.key] ?? sec.active))}
          />
        ))}
      </nav>

      <div className="sidebar-spacer" />
      <SidebarFooter />
    </aside>
  );
}

interface SectionItem {
  id: string;
  label: string;
  to: string;
  /** Short text after the name: a tracker's Jira key, a team's head count. */
  meta?: string;
  /** Spoken in place of `meta` when the short form needs words. */
  metaLabel?: string;
  /** A project's accent, as a dot before the name. */
  color?: string;
  active: boolean;
}

interface SectionDef {
  key: string;
  to: string;
  icon: IconName;
  label: string;
  active: boolean;
  empty: string;
  items: SectionItem[];
}

const OPEN_KEY = "planner_sidebar_open_v1";

/**
 * Which sections' lists are shown. A section the person never touched is open
 * while they are in it; once they open or close one, that choice sticks, per
 * device (localStorage), like the theme.
 */
function useOpenSections(): [
  Record<string, boolean>,
  (key: string, value: boolean) => void,
] {
  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    try {
      const raw = localStorage.getItem(OPEN_KEY);
      const v: unknown = raw ? JSON.parse(raw) : {};
      return v && typeof v === "object" ? (v as Record<string, boolean>) : {};
    } catch {
      return {};
    }
  });
  const toggle = (key: string, value: boolean) =>
    setOpen((prev) => {
      const next = { ...prev, [key]: value };
      try {
        localStorage.setItem(OPEN_KEY, JSON.stringify(next));
      } catch {
        // Storage blocked: the choice still holds for this session.
      }
      return next;
    });
  return [open, toggle];
}

function SidebarSection({
  section,
  open,
  onToggle,
}: {
  section: SectionDef;
  open: boolean;
  onToggle: () => void;
}) {
  const listId = `sidebar-list-${section.key}`;
  // The section link is the current page only on its own overview; inside
  // one of its items, the item is.
  const onItem = section.items.some((i) => i.active);
  return (
    <div className="sidebar-section">
      <div className="sidebar-section-row">
        <Link
          to={section.to}
          className={"sidebar-link" + (section.active ? " active" : "")}
          aria-current={section.active && !onItem ? "page" : undefined}
        >
          <Icon name={section.icon} size={17} />
          <span>{section.label}</span>
        </Link>
        <button
          type="button"
          className={
            "sidebar-toggle" +
            (section.active ? " on-active" : "") +
            (open ? " open" : "")
          }
          aria-expanded={open}
          aria-controls={listId}
          aria-label={`${open ? "Hide" : "Show"} ${section.label.toLowerCase()}`}
          title={`${open ? "Hide" : "Show"} ${section.label.toLowerCase()}`}
          onClick={onToggle}
        >
          <Icon name="chevronRight" size={14} />
        </button>
      </div>
      {open && (
        <ul id={listId} className="sidebar-items" aria-label={section.label}>
          {section.items.length === 0 ? (
            <li className="sidebar-item-empty">{section.empty}</li>
          ) : (
            section.items.map((item) => (
              <li key={item.id}>
                <Link
                  to={item.to}
                  className={"sidebar-item" + (item.active ? " active" : "")}
                  aria-current={item.active ? "page" : undefined}
                  title={item.label}
                >
                  <span
                    className="sidebar-item-dot"
                    style={
                      item.color
                        ? { ["--dot" as string]: item.color }
                        : undefined
                    }
                    aria-hidden="true"
                  />
                  <span className="sidebar-item-label">{item.label}</span>
                  {item.meta && (
                    <span
                      className="sidebar-item-meta"
                      aria-label={item.metaLabel}
                    >
                      {item.meta}
                    </span>
                  )}
                </Link>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
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
