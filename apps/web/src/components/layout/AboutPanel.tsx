import { useEffect, useState } from "react";
import { useAppStore } from "@planner/client-runtime";
import type { UpdateState } from "@planner/core";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { APP_VERSION, REPO_URL, RELEASES_URL } from "../../lib/appInfo";
import { hostBridge } from "../../lib/hostBridge";
import { useUpdates } from "../../lib/updates";
import {
  normalizeSyncUrl,
  readSyncUrlSetting,
  writeSyncUrlSetting,
} from "../../lib/syncSettings";
import { resolveSync } from "../../runtime";
import { BackupSection } from "./BackupSection";

interface AboutPanelProps {
  open: boolean;
  onClose: () => void;
}

const SYNC_LABEL: Record<string, string> = {
  offline: "Not connected",
  connecting: "Connecting…",
  syncing: "Syncing…",
  live: "Connected and up to date",
  incompatible: "The server runs an incompatible version",
};

function checkedLabel(state: UpdateState): string {
  if (!state.checkedAt) return "";
  const at = new Date(state.checkedAt);
  return ` · checked ${at.toLocaleString(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  })}`;
}

function UpdatesSection() {
  const { state, check, download, install } = useUpdates();
  const latest = state.latest;

  return (
    <section className="about-section" aria-labelledby="about-updates">
      <h4 id="about-updates">Updates</h4>

      {state.status === "available" && latest && (
        <>
          <p className="about-status">
            <strong>Version {latest.version} is available.</strong>{" "}
            <a href={latest.pageUrl} target="_blank" rel="noreferrer">
              What's new
            </a>
          </p>
          {state.message && <p className="modal-hint">{state.message}</p>}
          <div className="about-actions">
            {state.canInstall ? (
              <Button variant="primary" onClick={download}>
                Download and install
              </Button>
            ) : (
              <a
                className="btn primary"
                href={latest.pageUrl}
                target="_blank"
                rel="noreferrer"
              >
                Get it on GitHub
              </a>
            )}
          </div>
        </>
      )}

      {state.status === "downloading" && (
        <>
          <p className="about-status" id="about-download-label">
            Downloading version {latest?.version}…
          </p>
          <progress
            className="about-progress"
            aria-labelledby="about-download-label"
            max={1}
            value={state.progress ?? 0}
          />
        </>
      )}

      {state.status === "ready" && (
        <>
          <p className="about-status">
            <strong>Version {latest?.version} is ready.</strong> Planner will
            close and reopen on the new version. Your data stays where it is.
          </p>
          <div className="about-actions">
            <Button variant="primary" onClick={install}>
              Restart now
            </Button>
          </div>
        </>
      )}

      {(state.status === "idle" ||
        state.status === "checking" ||
        state.status === "up-to-date" ||
        state.status === "error") && (
        <>
          <p className="about-status" role="status">
            {state.status === "checking"
              ? "Checking…"
              : state.status === "up-to-date"
                ? `You're on the latest version${checkedLabel(state)}`
                : state.status === "error"
                  ? state.message
                  : "Planner checks for new versions automatically."}
          </p>
          <div className="about-actions">
            <Button onClick={check} disabled={state.status === "checking"}>
              Check for updates
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

function SyncSection() {
  const { syncStatus } = useAppStore();
  const host = hostBridge();
  const { url, source } = resolveSync();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const stored = readSyncUrlSetting();

  useEffect(() => {
    setDraft(stored ?? "");
    setError(null);
  }, [stored]);

  const status = url ? (SYNC_LABEL[syncStatus] ?? syncStatus) : null;

  if (host) {
    const shareUrl = host.share?.url ?? null;
    return (
      <section className="about-section" aria-labelledby="about-sync">
        <h4 id="about-sync">Sharing</h4>
        {shareUrl ? (
          <>
            <p className="about-status">
              Open <code>{shareUrl}</code> in any browser on this Mac to see and
              edit the same projects. Changes appear everywhere live.
            </p>
            <p className="modal-hint">Status: {status}</p>
            <div className="about-actions">
              <Button onClick={() => void host.share?.open()}>
                Open in browser
              </Button>
            </div>
          </>
        ) : url ? (
          <p className="about-status">
            Syncing with <code>{url}</code> · {status}
          </p>
        ) : (
          <p className="about-status">
            Sharing is off. Your data stays in this app only.
          </p>
        )}
      </section>
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

  function stop() {
    writeSyncUrlSetting(null);
    window.location.reload();
  }

  return (
    <section className="about-section" aria-labelledby="about-sync">
      <h4 id="about-sync">Sync</h4>
      {url ? (
        <p className="about-status">
          {source === "same-origin"
            ? "This page is served by a Planner server, so it shows that server's data."
            : `Syncing with ${url}.`}{" "}
          <span className="muted">{status}</span>
        </p>
      ) : (
        <p className="about-status">
          This browser keeps its own copy of your data. To see the same data as
          the Mac app, open <code>http://localhost:5191</code> while the app is
          running — or connect this page to a sync server below.
        </p>
      )}

      {source !== "same-origin" && (
        <>
          <label className="modal-field-label" htmlFor="about-sync-url">
            Sync server
          </label>
          <div className="about-row">
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
            <Button variant="primary" onClick={save}>
              Connect
            </Button>
            {stored && <Button onClick={stop}>Disconnect</Button>}
          </div>
          <p
            className="modal-hint"
            id="about-sync-hint"
            role={error ? "alert" : undefined}
          >
            {error ??
              "Your data here is merged with the server's when you connect. The page reloads to apply it."}
          </p>
        </>
      )}
    </section>
  );
}

/**
 * Version, updates, where the data is shared, and backup/transfer — the
 * app's "About" box, opened from the version in the header.
 */
export function AboutPanel({ open, onClose }: AboutPanelProps) {
  return (
    <Modal open={open} onClose={onClose} title="About Planner">
      <p className="about-version">
        Version <strong>{APP_VERSION}</strong>
        {REPO_URL && (
          <>
            {" · "}
            <a href={REPO_URL} target="_blank" rel="noreferrer">
              Source on GitHub
            </a>
          </>
        )}
        {RELEASES_URL && (
          <>
            {" · "}
            <a href={RELEASES_URL} target="_blank" rel="noreferrer">
              All releases
            </a>
          </>
        )}
      </p>
      <UpdatesSection />
      <SyncSection />
      <BackupSection />
      <div className="modal-actions">
        <Button onClick={onClose}>Close</Button>
      </div>
    </Modal>
  );
}
