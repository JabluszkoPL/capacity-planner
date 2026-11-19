import { useEffect, useId, useRef, useState } from "react";
import { useAppStore } from "@planner/client-runtime";
import { mergeImportedState, type MergeReport } from "@planner/core";
import { Button } from "../ui/Button";
import { useToast } from "../ui/Toast";
import { downloadBlob, readTextFile } from "../../lib/download";
import {
  applyDeviceBackup,
  backupFilename,
  buildDeviceBackup,
  parseBackup,
  type ParsedBackup,
} from "../../lib/backup";
import { isJiraConfigured } from "../../lib/jiraSettings";
import { useJiraSettings } from "../../lib/useJiraSettings";

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "2 projects, 1 team and 3 trackers", leaving out the zeros. */
function countList(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "nothing";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function newItems(report: MergeReport): string[] {
  const parts: string[] = [];
  if (report.addedProjects > 0) {
    parts.push(plural(report.addedProjects, "project", "projects"));
  }
  if (report.addedTeams > 0) {
    parts.push(plural(report.addedTeams, "team", "teams"));
  }
  if (report.addedTrackers > 0) {
    parts.push(plural(report.addedTrackers, "tracker", "trackers"));
  }
  return parts;
}

function hostOf(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

/**
 * Backup and transfer: everything on this device in one file, and that file
 * read back — here, in the Mac app, or in another browser.
 *
 * The export is a full backup (every project, team and tracker, with tracker
 * history) plus this device's settings that live outside the data: the Jira
 * connection and the remembered tag mappings. The Jira API token is left out
 * unless the user asks for it, because anyone holding the file could use it.
 *
 * Import shows what the file holds before anything changes. Data is merged in
 * additively (see `mergeImportedState`), and the Jira connection is only
 * replaced when the user leaves that box ticked.
 */
export function BackupSection() {
  const { state, actions } = useAppStore();
  const jira = useJiraSettings();
  const toast = useToast();
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLButtonElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  const [includeToken, setIncludeToken] = useState(false);
  const [pending, setPending] = useState<
    (ParsedBackup & { fileName: string }) | null
  >(null);
  const [replaceJira, setReplaceJira] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const jiraHere = isJiraConfigured(jira);

  useEffect(() => {
    if (pending) previewRef.current?.focus();
  }, [pending]);

  const exportAll = () => {
    const text = buildDeviceBackup(state, includeToken && jiraHere);
    downloadBlob(
      new Blob([text], { type: "application/json" }),
      backupFilename(),
    );
    toast(
      includeToken && jiraHere
        ? "Backup saved, including your Jira API token. Keep the file private."
        : "Backup saved.",
    );
  };

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const parsed = parseBackup(await readTextFile(file));
      const incomingJira = parsed.device?.jira;
      // Take the file's Jira connection by default unless this device is
      // already connected to a different account.
      setReplaceJira(
        !!incomingJira &&
          (!jiraHere ||
            (jira.baseUrl === incomingJira.baseUrl &&
              jira.email === incomingJira.email)),
      );
      setPending({ ...parsed, fileName: file.name });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't read that file.");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const cancel = () => {
    setPending(null);
    importRef.current?.focus();
  };

  const confirmImport = () => {
    if (!pending) return;
    // Merge against the state as it is now, not as it was when the file was
    // picked: something may have synced in the meantime.
    const report = mergeImportedState(state, pending.state);
    const added = newItems(report);
    if (added.length > 0) actions.importState(report.state);

    const device = pending.device
      ? applyDeviceBackup(pending.device, { replaceJira })
      : null;

    const parts: string[] = [];
    parts.push(
      added.length > 0
        ? `Imported ${countList(added)}`
        : "No new projects, teams or trackers",
    );
    if (device?.jira) {
      parts.push(
        device.jiraNeedsToken
          ? "Jira connection set; add your API token in Jira settings"
          : "Jira connected",
      );
    }
    if (device && device.addedTagAliases > 0) {
      parts.push(plural(device.addedTagAliases, "tag mapping", "tag mappings"));
    }
    if (report.renamedProjects.length > 0) {
      parts.push(`renamed ${report.renamedProjects.join(", ")}`);
    }
    toast(parts.join(" · "));
    setPending(null);
    importRef.current?.focus();
  };

  const preview = pending ? mergeImportedState(state, pending.state) : null;
  const previewNew = preview ? newItems(preview) : [];
  const incomingJira = pending?.device?.jira;
  const fileTotals = pending
    ? countList([
        plural(pending.state.projects.length, "project", "projects"),
        plural(pending.state.teams.length, "team", "teams"),
        plural(pending.state.trackers?.length ?? 0, "tracker", "trackers"),
      ])
    : "";

  return (
    <section className="about-section" aria-labelledby={`${id}-heading`}>
      <h4 id={`${id}-heading`}>Backup and transfer</h4>
      <p className="about-status">
        Save everything on this device to one file: projects, teams, Jira
        trackers with their history, and the Jira connection. Import it in the
        Mac app or another browser to move your work there.
      </p>

      <label className="about-check">
        <input
          type="checkbox"
          checked={includeToken && jiraHere}
          disabled={!jiraHere}
          onChange={(e) => setIncludeToken(e.target.checked)}
          aria-describedby={`${id}-token-hint`}
        />
        <span>Include the Jira API token</span>
      </label>
      <p className="modal-hint" id={`${id}-token-hint`}>
        {!jiraHere ? (
          "Jira isn't connected on this device."
        ) : includeToken ? (
          <span className="about-warning">
            Anyone with the file can use Jira as {jira.email}. Delete it once
            it's imported.
          </span>
        ) : (
          "Without it, the Jira site and email still come along; you type the token once on the new device."
        )}
      </p>

      <div className="about-actions">
        <Button onClick={exportAll}>Export everything</Button>
        <input
          ref={inputRef}
          type="file"
          accept="application/json,.json"
          hidden
          aria-label="Backup file"
          onChange={(e) => void pickFile(e.target.files?.[0])}
        />
        {/* A plain button, not <Button>: focus returns here after an import,
            and <Button> does not forward refs. */}
        <button
          ref={importRef}
          type="button"
          className="btn"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
        >
          {busy ? "Reading…" : "Import backup…"}
        </button>
      </div>
      {error && (
        <p className="modal-hint about-warning" role="alert">
          {error}
        </p>
      )}

      {pending && preview && (
        <div
          ref={previewRef}
          className="backup-preview"
          tabIndex={-1}
          role="group"
          aria-label={`Import ${pending.fileName}`}
        >
          <p className="about-status">
            <strong>{pending.fileName}</strong> holds {fileTotals}.{" "}
            {previewNew.length > 0
              ? `${countList(previewNew)} will be added; nothing here is replaced.`
              : "Everything in it is already here."}
          </p>
          {incomingJira && (
            <>
              <label className="about-check">
                <input
                  type="checkbox"
                  checked={replaceJira}
                  onChange={(e) => setReplaceJira(e.target.checked)}
                />
                <span>
                  Use its Jira connection ({incomingJira.email} @{" "}
                  {hostOf(incomingJira.baseUrl)})
                  {jiraHere &&
                  (jira.baseUrl !== incomingJira.baseUrl ||
                    jira.email !== incomingJira.email)
                    ? ", replacing this device's"
                    : ""}
                </span>
              </label>
              <p className="modal-hint">
                {incomingJira.apiToken
                  ? "The file includes an API token."
                  : "The file has no API token; add it in Jira settings afterwards."}{" "}
                Writing to Jira stays as it is on this device.
              </p>
            </>
          )}
          <div className="about-actions">
            <Button onClick={cancel}>Cancel</Button>
            <Button
              variant="primary"
              onClick={confirmImport}
              disabled={
                previewNew.length === 0 &&
                !(incomingJira && replaceJira) &&
                !pending.device?.tagAliases
              }
            >
              Import
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
