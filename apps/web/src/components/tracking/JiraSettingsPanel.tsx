import { useEffect, useState } from "react";
import { basicAuth } from "@planner/jira";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { useToast } from "../ui/Toast";
import { useConfirm } from "../ui/ConfirmDialog";
import {
  DEFAULT_HOURS_PER_DAY,
  clearJiraSettings,
  isJiraConfigured,
  writeJiraSettings,
  type JiraSettings,
} from "../../lib/jiraSettings";
import type { AppJiraTransport } from "../../lib/jiraTransport";

interface JiraSettingsPanelProps {
  open: boolean;
  onClose: () => void;
  settings: JiraSettings;
  transport: AppJiraTransport;
}

/** What `/rest/api/3/myself` gives back, as far as we care. */
function displayNameOf(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const v = body as Record<string, unknown>;
  if (typeof v.displayName === "string") return v.displayName;
  if (typeof v.emailAddress === "string") return v.emailAddress;
  return null;
}

/** Reject a proxy fallback page that happens to answer HTTP 200. */
function isJiraProfile(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const v = body as Record<string, unknown>;
  return (
    typeof v.accountId === "string" ||
    typeof v.displayName === "string" ||
    typeof v.emailAddress === "string"
  );
}

/**
 * Where the Jira connection is set up.
 *
 * The token field is a password input and the stored value is never shown
 * back: an existing token renders as a placeholder, and leaving the field
 * untouched keeps it. Re-typing a token you cannot read is worse than useless
 * — people paste the wrong one and cannot tell.
 */
export function JiraSettingsPanel({
  open,
  onClose,
  settings,
  transport,
}: JiraSettingsPanelProps) {
  const toast = useToast();
  const confirm = useConfirm();
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl);
  const [email, setEmail] = useState(settings.email);
  const [token, setToken] = useState("");
  const [hours, setHours] = useState(String(settings.hoursPerDay));
  const [allowWrites, setAllowWrites] = useState(settings.allowWrites);
  const [testing, setTesting] = useState(false);

  // Re-seed the form each time the panel opens, so it always reflects what is
  // actually stored rather than a half-finished edit from last time.
  useEffect(() => {
    if (!open) return;
    setBaseUrl(settings.baseUrl);
    setEmail(settings.email);
    setToken("");
    setHours(String(settings.hoursPerDay));
    setAllowWrites(settings.allowWrites);
  }, [open, settings]);

  const hasStoredToken = settings.apiToken.length > 0;

  function current(): JiraSettings {
    const parsedHours = Number(hours);
    return {
      baseUrl: baseUrl.trim().replace(/\/+$/, ""),
      email: email.trim(),
      apiToken: token.length > 0 ? token.trim() : settings.apiToken,
      hoursPerDay:
        Number.isFinite(parsedHours) && parsedHours > 0
          ? parsedHours
          : DEFAULT_HOURS_PER_DAY,
      allowWrites,
    };
  }

  async function test() {
    const next = current();
    if (!isJiraConfigured(next)) {
      toast("Fill in the URL, email and token first");
      return;
    }
    setTesting(true);
    try {
      const res = await transport.request({
        baseUrl: next.baseUrl,
        path: "/rest/api/3/myself",
        method: "GET",
        auth: basicAuth(next.email, next.apiToken),
      });
      if (res.status === 200) {
        if (!isJiraProfile(res.body)) {
          toast("The Jira route returned an unexpected response", {
            isError: true,
            context: `Jira: ${next.baseUrl}\nEndpoint: /rest/api/3/myself\nAt: ${new Date().toISOString()}`,
          });
          return;
        }

        // `/myself` only proves authentication. Refresh also needs field
        // discovery, so test that before claiming data can be downloaded.
        const fields = await transport.request({
          baseUrl: next.baseUrl,
          path: "/rest/api/3/field",
          method: "GET",
          auth: basicAuth(next.email, next.apiToken),
        });
        if (fields.status !== 200 || !Array.isArray(fields.body)) {
          toast(
            fields.status === 401 || fields.status === 403
              ? "Jira accepted the connection but denied data access"
              : "Jira connected, but issue data could not be downloaded",
            {
              isError: true,
              context: `Jira: ${next.baseUrl}\nEndpoint: /rest/api/3/field\nHTTP ${fields.status}\nAt: ${new Date().toISOString()}`,
            },
          );
          return;
        }

        // A successful test proves `next` works against Jira and can read the
        // data refresh depends on, so save it now. Refresh reads persisted
        // settings rather than this dialog's draft state.
        writeJiraSettings(next);
        const who = displayNameOf(res.body);
        toast(
          who
            ? `Connected as ${who} — data access verified and saved`
            : "Connected to Jira — data access verified and saved",
        );
      } else if (res.status === 401 || res.status === 403) {
        toast("Jira rejected that email and token", {
          isError: true,
          context: `Jira: ${next.baseUrl}\nEmail: ${next.email}\nHTTP ${res.status}\nAt: ${new Date().toISOString()}`,
        });
      } else {
        toast(`Jira answered ${res.status}`, {
          isError: true,
          context: `Jira: ${next.baseUrl}\nHTTP ${res.status}\nAt: ${new Date().toISOString()}`,
        });
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Could not reach Jira";
      toast(message, {
        isError: true,
        context: `Jira: ${next.baseUrl}\nAt: ${new Date().toISOString()}`,
      });
    } finally {
      setTesting(false);
    }
  }

  function save() {
    writeJiraSettings(current());
    toast("Jira settings saved");
    onClose();
  }

  async function forget() {
    const ok = await confirm({
      title: "Clear Jira credentials",
      message:
        "This removes the stored Jira URL, email and API token from this device. You'll need to re-enter them to reconnect.",
      confirmLabel: "Clear credentials",
      danger: true,
    });
    if (!ok) return;
    clearJiraSettings();
    toast("Jira credentials cleared");
    onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title="Jira connection">
      <div className="jira-settings">
        <p className="muted">
          Planner talks to Jira with your own Atlassian API token. It is stored
          on this device only — never synced to your other devices, and never
          part of an export.
        </p>

        <div className="field">
          <label htmlFor="jira-url">Jira URL</label>
          <input
            id="jira-url"
            type="url"
            value={baseUrl}
            placeholder="https://your-company.atlassian.net"
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="jira-email">Atlassian email</label>
          <input
            id="jira-email"
            type="email"
            value={email}
            placeholder="you@company.com"
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="jira-token">API token</label>
          <input
            id="jira-token"
            type="password"
            value={token}
            autoComplete="off"
            placeholder={hasStoredToken ? "•••••••• (stored)" : "paste token"}
            onChange={(e) => setToken(e.target.value)}
          />
          <p className="muted">
            Create one at{" "}
            <a
              href="https://id.atlassian.com/manage-profile/security/api-tokens"
              target="_blank"
              rel="noreferrer"
            >
              id.atlassian.com
            </a>{" "}
            under Security → API tokens.
          </p>
        </div>

        <div className="field">
          <label htmlFor="jira-hours">Hours in a working day</label>
          <input
            id="jira-hours"
            type="number"
            min={1}
            max={24}
            step={0.5}
            value={hours}
            onChange={(e) => setHours(e.target.value)}
          />
          <p className="muted">
            Used to turn Jira's time tracking into Planner days.
          </p>
        </div>

        <label className="jira-writes">
          <input
            type="checkbox"
            checked={allowWrites}
            disabled={!transport.canWrite}
            onChange={(e) => setAllowWrites(e.target.checked)}
          />
          <span>Allow Planner to write start and due dates back to Jira</span>
        </label>
        {!transport.canWrite && transport.kind !== "none" && (
          <p className="muted">This device can only read from Jira.</p>
        )}

        <p className="muted">
          {transport.unavailableReason ??
            `Refresh runs ${transport.description}.`}
        </p>

        <div className="modal-actions">
          <Button onClick={test} disabled={testing}>
            {testing ? "Testing…" : "Test connection"}
          </Button>
          {hasStoredToken && (
            <Button variant="danger" onClick={forget}>
              Clear credentials
            </Button>
          )}
          <span className="spacer" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save}>
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}
