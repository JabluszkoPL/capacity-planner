import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useAppStore } from "@planner/client-runtime";
import type { UpdateState } from "@planner/core";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Badge, type Tone } from "../ui/Badge";
import { Icon, type IconName } from "../ui/Icon";
import { APP_VERSION, REPO_URL, RELEASES_URL } from "../../lib/appInfo";
import { hostBridge } from "../../lib/hostBridge";
import { useUpdates } from "../../lib/updates";
import { useTheme, type ThemeChoice } from "../../lib/theme";
import { Segmented, type SegmentedOption } from "../ui/Segmented";
import { isJiraConfigured } from "../../lib/jiraSettings";
import { useJiraSettings } from "../../lib/useJiraSettings";
import {
  normalizeSyncUrl,
  readSyncUrlSetting,
  writeSyncUrlSetting,
} from "../../lib/syncSettings";
import { resolveSync } from "../../runtime";
import { BackupSection } from "./BackupSection";
import { McpSection } from "./McpSection";
import { SettingsGroup, SettingsRow } from "./SettingsRows";

interface AboutPanelProps {
  open: boolean;
  onClose: () => void;
  /** Opens the Jira connection dialog; shows a Jira row under General. */
  onOpenJira?: () => void;
}

const SYNC_LABEL: Record<string, string> = {
  offline: "Not connected",
  connecting: "Connecting…",
  syncing: "Syncing…",
  live: "Connected and up to date",
  incompatible: "The server runs an incompatible version",
};

/** The same states, short enough for a badge. */
const SYNC_BADGE: Record<string, { text: string; tone: Tone }> = {
  offline: { text: "Not connected", tone: "neutral" },
  connecting: { text: "Connecting", tone: "info" },
  syncing: { text: "Syncing", tone: "info" },
  live: { text: "Connected", tone: "success" },
  incompatible: { text: "Incompatible", tone: "danger" },
};

function SyncBadge({ status }: { status: string }) {
  const badge = SYNC_BADGE[status] ?? { text: status, tone: "neutral" };
  return (
    <Badge tone={badge.tone} dot title={SYNC_LABEL[status] ?? status}>
      {badge.text}
    </Badge>
  );
}

function checkedLabel(state: UpdateState): string {
  if (!state.checkedAt) return "";
  const at = new Date(state.checkedAt);
  return ` · checked ${at.toLocaleString(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  })}`;
}

function updateBadge(state: UpdateState): ReactNode {
  switch (state.status) {
    case "up-to-date":
      return (
        <Badge tone="success" icon={<Icon name="check" size={13} />}>
          Up to date
        </Badge>
      );
    case "available":
      return (
        <Badge tone="accent" dot>
          Update available
        </Badge>
      );
    case "downloading":
      return <Badge tone="info">Downloading</Badge>;
    case "ready":
      return (
        <Badge tone="success" dot>
          Ready to install
        </Badge>
      );
    case "error":
      return <Badge tone="danger">Check failed</Badge>;
    default:
      return null;
  }
}

const THEME_OPTIONS: SegmentedOption<ThemeChoice>[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** Light, dark or follow the device. Per device, never synced. */
function AppearanceGroup() {
  const [theme, setTheme] = useTheme();
  return (
    <SettingsGroup title="Appearance" icon="image">
      <SettingsRow
        label="Theme"
        hint="System follows your device's light or dark setting. Saved on this device only."
      >
        <Segmented
          label="Theme"
          options={THEME_OPTIONS}
          value={theme}
          onChange={setTheme}
        />
      </SettingsRow>
    </SettingsGroup>
  );
}

function UpdatesSection() {
  const { state, check, download, install } = useUpdates();
  const latest = state.latest;

  return (
    <SettingsGroup title="Updates" icon="download" status={updateBadge(state)}>
      <SettingsRow label="Installed version">
        <span className="settings-value">{APP_VERSION}</span>
      </SettingsRow>

      {state.status === "available" && latest && (
        <SettingsRow
          label={<strong>Version {latest.version} is available.</strong>}
          hint={
            <p className="settings-hint">
              <a href={latest.pageUrl} target="_blank" rel="noreferrer">
                What's new
              </a>
              {state.message && <> · {state.message}</>}
            </p>
          }
        >
          {state.canInstall ? (
            <Button variant="primary" icon="download" onClick={download}>
              Download and install
            </Button>
          ) : (
            <a
              className="btn primary"
              href={latest.pageUrl}
              target="_blank"
              rel="noreferrer"
            >
              <Icon name="external" size={15} />
              Get it on GitHub
            </a>
          )}
        </SettingsRow>
      )}

      {state.status === "downloading" && (
        <SettingsRow
          stacked
          label={`Downloading version ${latest?.version}…`}
          labelId="about-download-label"
        >
          <progress
            className="about-progress"
            aria-labelledby="about-download-label"
            max={1}
            value={state.progress ?? 0}
          />
        </SettingsRow>
      )}

      {state.status === "ready" && (
        <SettingsRow
          label={<strong>Version {latest?.version} is ready.</strong>}
          hint={
            <p className="settings-hint">
              Planner will close and reopen on the new version. Your data stays
              where it is.
            </p>
          }
        >
          <Button variant="primary" icon="refresh" onClick={install}>
            Restart now
          </Button>
        </SettingsRow>
      )}

      {(state.status === "idle" ||
        state.status === "checking" ||
        state.status === "up-to-date" ||
        state.status === "error") && (
        <SettingsRow
          label="New versions"
          hint={
            <p
              className={
                "settings-hint" +
                (state.status === "error" ? " about-warning" : "")
              }
              role="status"
            >
              {state.status === "checking"
                ? "Checking…"
                : state.status === "up-to-date"
                  ? `You're on the latest version${checkedLabel(state)}`
                  : state.status === "error"
                    ? state.message
                    : "Planner checks for new versions automatically."}
            </p>
          }
        >
          <Button
            icon="refresh"
            onClick={check}
            disabled={state.status === "checking"}
          >
            Check for updates
          </Button>
        </SettingsRow>
      )}
    </SettingsGroup>
  );
}

function SyncSection() {
  const { syncStatus } = useAppStore();
  const host = hostBridge();
  const { url, source } = resolveSync();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [stopped, setStopped] = useState(false);
  const [stopping, setStopping] = useState(false);
  const stored = readSyncUrlSetting();

  useEffect(() => {
    setDraft(stored ?? "");
    setError(null);
  }, [stored]);

  if (host) {
    const shareUrl = host.share?.url ?? null;
    const foreignVersion = host.share?.foreignVersion ?? null;
    const canStop = !!host.share?.stop;
    return (
      <SettingsGroup
        title="Sharing"
        icon="cloud"
        status={
          url ? (
            <SyncBadge status={syncStatus} />
          ) : (
            <Badge tone="neutral">Off</Badge>
          )
        }
        description={
          !shareUrl && !url ? (
            <p>Sharing is off. Your data stays in this app only.</p>
          ) : undefined
        }
      >
        {shareUrl ? (
          <>
            {foreignVersion && (
              <p className="settings-note" role="note">
                {foreignVersion === "unknown"
                  ? "Another Planner server was already running on this port, "
                  : `Another Planner server (v${foreignVersion}) was already running on this port, `}
                for example <code>pnpm dev</code> or <code>pnpm serve</code>.
                This app is syncing with it, and the browser shows that server's
                version of Planner
                {foreignVersion !== "unknown" && foreignVersion !== APP_VERSION
                  ? `, not v${APP_VERSION}`
                  : ""}
                . Stop it and reopen Planner to use the app's own server.
              </p>
            )}
            <SettingsRow
              label="Browser access"
              hint={
                <p className="settings-hint">
                  Open <code>{shareUrl}</code> in any browser on this Mac to see
                  and edit the same projects. Changes appear everywhere live.
                </p>
              }
            >
              <Button
                icon="external"
                disabled={stopped}
                onClick={() => void host.share?.open()}
              >
                Open in browser
              </Button>
            </SettingsRow>
            {canStop && (
              <SettingsRow
                label="Web server"
                hint={
                  <p
                    className={
                      "settings-hint" + (error ? " about-warning" : "")
                    }
                    role={error ? "alert" : "status"}
                  >
                    {error ??
                      (stopped
                        ? "Web server stopped. Reopen Planner to start the current version. Browser access and sync are paused."
                        : "Stop the web server if the browser still shows an old version after updating. Reopen Planner to start it again.")}
                  </p>
                }
              >
                <Button
                  icon="x"
                  disabled={stopping || stopped}
                  onClick={async () => {
                    setStopping(true);
                    setError(null);
                    try {
                      await host.share?.stop?.();
                      setStopped(true);
                    } catch (cause) {
                      setError(
                        cause instanceof Error
                          ? cause.message
                          : "Could not stop the server.",
                      );
                    } finally {
                      setStopping(false);
                    }
                  }}
                >
                  {stopping ? "Stopping…" : "Stop web server"}
                </Button>
              </SettingsRow>
            )}
          </>
        ) : url ? (
          <SettingsRow label="Syncing with">
            <code className="settings-code">{url}</code>
          </SettingsRow>
        ) : null}
      </SettingsGroup>
    );
  }

  function save() {
    const normalized = normalizeSyncUrl(draft);
    if (!normalized) {
      setError("Enter a server address, for example localhost:5191.");
      return;
    }
    if (writeSyncUrlSetting(normalized)) window.location.reload();
    else setError("This browser won't save settings (private mode?).");
  }

  function disconnect() {
    writeSyncUrlSetting(null);
    window.location.reload();
  }

  return (
    <SettingsGroup
      title="Sync"
      icon="cloud"
      status={
        url ? (
          <SyncBadge status={syncStatus} />
        ) : (
          <Badge tone="neutral">This browser only</Badge>
        )
      }
      description={
        url ? (
          <p>
            {source === "same-origin"
              ? "This page is served by a Planner server, so it shows that server's data."
              : `Syncing with ${url}.`}
          </p>
        ) : (
          <p>
            This browser keeps its own copy of your data. To see the same data
            as the Mac app, open <code>http://localhost:5191</code> while the
            app is running — or connect this page to a sync server below.
          </p>
        )
      }
    >
      {source !== "same-origin" && (
        <SettingsRow
          stacked
          label="Sync server"
          htmlFor="about-sync-url"
          hint={
            <p
              className={"settings-hint" + (error ? " about-warning" : "")}
              id="about-sync-hint"
              role={error ? "alert" : undefined}
            >
              {error ??
                "Your data here is merged with the server's when you connect. The page reloads to apply it."}
            </p>
          }
        >
          <input
            id="about-sync-url"
            type="text"
            placeholder="localhost:5191"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
            }}
            aria-describedby="about-sync-hint"
            aria-invalid={error ? true : undefined}
          />
          <Button variant="primary" icon="link" onClick={save}>
            Connect
          </Button>
          {stored && <Button onClick={disconnect}>Disconnect</Button>}
        </SettingsRow>
      )}
    </SettingsGroup>
  );
}

function AboutSection() {
  return (
    <SettingsGroup
      title="Planner"
      icon="info"
      description={
        <p>
          Capacity planning for projects and teams: estimates, people and days
          off go in, a schedule and a timeline come out. Every device keeps a
          full copy of your data and works offline.
        </p>
      }
    >
      <SettingsRow label="Version">
        <span className="settings-value">v{APP_VERSION}</span>
      </SettingsRow>
      {REPO_URL && (
        <SettingsRow label="Source code">
          <a className="btn" href={REPO_URL} target="_blank" rel="noreferrer">
            <Icon name="external" size={15} />
            Source on GitHub
          </a>
        </SettingsRow>
      )}
      {RELEASES_URL && (
        <SettingsRow label="Release notes">
          <a
            className="btn"
            href={RELEASES_URL}
            target="_blank"
            rel="noreferrer"
          >
            <Icon name="external" size={15} />
            All releases
          </a>
        </SettingsRow>
      )}
    </SettingsGroup>
  );
}

type SectionKey = "general" | "sync" | "backup" | "mcp" | "about";

interface SectionDef {
  key: SectionKey;
  label: string;
  icon: IconName;
  render: (ctx: SectionContext) => ReactNode;
}

interface SectionContext {
  onOpenJira?: () => void;
}

/**
 * The Jira connection lives in its own dialog (JiraSettingsPanel); this row
 * only says whether it is set up and opens it.
 */
function JiraGroup({ onOpenJira }: { onOpenJira: () => void }) {
  const settings = useJiraSettings();
  const connected = isJiraConfigured(settings);
  return (
    <SettingsGroup
      title="Jira"
      icon="jira"
      status={
        <Badge tone={connected ? "success" : "neutral"} dot>
          {connected ? "Connected" : "Not connected"}
        </Badge>
      }
    >
      <SettingsRow
        label="Jira connection"
        hint={
          connected
            ? `${settings.email} @ ${settings.baseUrl.replace(/^https?:\/\//, "")}`
            : "Site, email and API token, kept on this device only."
        }
      >
        <Button icon="plug" onClick={onOpenJira}>
          {connected ? "Edit connection…" : "Connect Jira…"}
        </Button>
      </SettingsRow>
    </SettingsGroup>
  );
}

const SECTIONS: SectionDef[] = [
  {
    key: "general",
    label: "General",
    icon: "settings",
    render: ({ onOpenJira }) => (
      <>
        <AppearanceGroup />
        <UpdatesSection />
        {onOpenJira && <JiraGroup onOpenJira={onOpenJira} />}
      </>
    ),
  },
  {
    key: "sync",
    label: "Sync & sharing",
    icon: "cloud",
    render: () => <SyncSection />,
  },
  {
    key: "backup",
    label: "Backup",
    icon: "box",
    render: () => <BackupSection />,
  },
  {
    key: "mcp",
    label: "AI assistants",
    icon: "sparkle",
    render: () => <McpSection />,
  },
  {
    key: "about",
    label: "About",
    icon: "info",
    render: () => <AboutSection />,
  },
];

/**
 * The dialog's body. Mounted only while the dialog is open, so it opens on
 * General each time. Every section stays mounted while it is open (only the
 * selected one is shown), so a half-typed sync address or a backup preview
 * survives a look at another section.
 */
function SettingsBody({ onOpenJira }: SectionContext) {
  const id = useId();
  // AI assistants is the Mac app's: a browser tab has no endpoint to offer.
  const hasMcp = !!hostBridge()?.mcp;
  const sections = SECTIONS.filter((s) => s.key !== "mcp" || hasMcp);
  const [selected, setSelected] = useState<SectionKey>("general");
  const tabRefs = useRef<Partial<Record<SectionKey, HTMLButtonElement | null>>>(
    {},
  );

  const tabId = (key: SectionKey) => `${id}-tab-${key}`;
  const panelId = (key: SectionKey) => `${id}-panel-${key}`;

  // A vertical tablist: arrows move and select (selection follows focus, as
  // each section is cheap to show), Home/End jump to the ends. Left/Right work
  // too, for the narrow layout where the list runs across the top.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = sections.findIndex((s) => s.key === selected);
    let next: number;
    switch (e.key) {
      case "ArrowDown":
      case "ArrowRight":
        next = (at + 1) % sections.length;
        break;
      case "ArrowUp":
      case "ArrowLeft":
        next = (at - 1 + sections.length) % sections.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = sections.length - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    const key = sections[next]!.key;
    setSelected(key);
    tabRefs.current[key]?.focus();
  };

  return (
    <div className="settings-layout">
      <div
        role="tablist"
        aria-label="Settings sections"
        aria-orientation="vertical"
        className="settings-tabs"
        onKeyDown={onKeyDown}
      >
        {sections.map((s) => {
          const active = s.key === selected;
          return (
            <button
              key={s.key}
              ref={(el) => {
                tabRefs.current[s.key] = el;
              }}
              type="button"
              role="tab"
              id={tabId(s.key)}
              aria-selected={active}
              aria-controls={panelId(s.key)}
              tabIndex={active ? 0 : -1}
              className={"settings-tab" + (active ? " active" : "")}
              onClick={() => setSelected(s.key)}
            >
              <Icon name={s.icon} size={16} />
              <span>{s.label}</span>
            </button>
          );
        })}
      </div>
      {sections.map((s) => (
        <div
          key={s.key}
          role="tabpanel"
          id={panelId(s.key)}
          aria-labelledby={tabId(s.key)}
          className="settings-panel"
          hidden={s.key !== selected}
        >
          {s.render({ onOpenJira })}
        </div>
      ))}
    </div>
  );
}

/**
 * The app's settings, opened from "Settings" at the bottom of the sidebar:
 * version and updates, where the data is shared, backup/transfer, AI
 * assistants (MCP) and about. A section list on the left, the selected
 * section on the right. The Jira connection has its own dialog.
 */
export function AboutPanel({ open, onClose, onOpenJira }: AboutPanelProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Settings"
      ariaLabel="About Planner"
      subtitle="Settings for Planner on this device."
      className="settings-modal"
    >
      <SettingsBody onOpenJira={onOpenJira} />
    </Modal>
  );
}
