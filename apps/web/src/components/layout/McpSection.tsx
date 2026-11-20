import { useEffect, useId, useState } from "react";
import { Button } from "../ui/Button";
import { Badge, type Tone } from "../ui/Badge";
import { useToast } from "../ui/Toast";
import {
  hostBridge,
  type McpHostState,
  type PlannerMcpBridge,
} from "../../lib/hostBridge";
import {
  claudeCodeCommand,
  codexCommands,
  mcpJsonConfig,
} from "../../mcp/installCommands";
import { SettingsGroup, SettingsRow } from "./SettingsRows";

const STATUS_BADGE: Record<
  McpHostState["status"],
  { text: string; tone: Tone }
> = {
  listening: { text: "On", tone: "success" },
  starting: { text: "Starting", tone: "info" },
  error: { text: "Not running", tone: "danger" },
  off: { text: "Off", tone: "neutral" },
};

function statusLine(s: McpHostState): string {
  switch (s.status) {
    case "listening":
      return `Listening at ${s.url}. Works while Planner is open.`;
    case "starting":
      return "Starting…";
    case "error":
      return s.error ?? "The server could not start.";
    default:
      return "Off. No AI client can reach Planner.";
  }
}

/** The live settings from the main process, kept current. */
function useMcpState(
  mcp: PlannerMcpBridge,
): [McpHostState | null, (s: McpHostState) => void] {
  const [state, setState] = useState<McpHostState | null>(null);
  useEffect(() => {
    let live = true;
    void mcp.state().then((s) => {
      if (live) setState(s);
    });
    const off = mcp.onChange((s) => setState(s));
    return () => {
      live = false;
      off();
    };
  }, [mcp]);
  return [state, setState];
}

/**
 * AI assistants: the Mac app's MCP endpoint, so Claude Code, Codex and other
 * MCP clients on this Mac can read plans, teams and trackers, show things in
 * this window and - only when allowed separately - change plans.
 *
 * Both switches start off. The token is copied inside each install command,
 * never shown on its own. Jira credentials are not reachable through MCP at
 * all, whatever is switched on here. Mac app only: a browser tab has no
 * endpoint to offer.
 */
export function McpSection() {
  const mcp = hostBridge()?.mcp;
  if (!mcp) return null;
  return <McpSettings mcp={mcp} />;
}

function McpSettings({ mcp }: { mcp: PlannerMcpBridge }) {
  const id = useId();
  const toast = useToast();
  const [state, setState] = useMcpState(mcp);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  if (!state) return null;

  async function update(patch: { enabled?: boolean; allowWrites?: boolean }) {
    setBusy(true);
    try {
      setState(await mcp.update(patch));
    } finally {
      setBusy(false);
    }
  }

  async function copy(label: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(`Copied the ${label}. It contains this Mac's access token.`);
    } catch {
      setCopied(null);
      toast("Couldn't copy to the clipboard.", { isError: true });
    }
  }

  async function regenerate() {
    setBusy(true);
    try {
      setState(await mcp.regenerateToken());
      setCopied(
        "New token made. Clients set up before now are disconnected until you copy their command again.",
      );
    } finally {
      setBusy(false);
    }
  }

  const on = state.enabled;
  const badge = STATUS_BADGE[state.status];

  return (
    <>
      <SettingsGroup
        title="AI assistants (MCP)"
        icon="sparkle"
        status={
          <Badge tone={badge.tone} dot>
            {badge.text}
          </Badge>
        }
        description={
          <p>
            Let Claude Code, Codex and other MCP clients on this Mac read your
            projects, plans, teams and Jira trackers while Planner is open, and
            open things in this window. Your Jira connection is never shared.
          </p>
        }
      >
        <SettingsRow
          label="Allow AI clients to connect"
          htmlFor={`${id}-connect`}
          hint={
            <p
              className={
                "settings-hint" +
                (state.status === "error" ? " about-warning" : "")
              }
              id={`${id}-status`}
              role="status"
            >
              {statusLine(state)}
            </p>
          }
        >
          <input
            id={`${id}-connect`}
            type="checkbox"
            className="settings-switch"
            checked={on}
            disabled={busy}
            onChange={(e) => void update({ enabled: e.target.checked })}
            aria-describedby={`${id}-status`}
          />
        </SettingsRow>
        <SettingsRow
          label="Allow changes to projects, teams and days off"
          htmlFor={`${id}-writes`}
          hint={
            <p className="settings-hint" id={`${id}-writes-hint`}>
              {state.allowWrites ? (
                <span className="about-warning">
                  Clients can edit plans and people, and the edits sync to your
                  other devices. There is no undo; nothing can be deleted.
                </span>
              ) : (
                "Off: clients can read and open things, but not change them."
              )}
            </p>
          }
        >
          <input
            id={`${id}-writes`}
            type="checkbox"
            className="settings-switch"
            checked={state.allowWrites}
            disabled={busy || !on}
            onChange={(e) => void update({ allowWrites: e.target.checked })}
            aria-describedby={`${id}-writes-hint`}
          />
        </SettingsRow>
      </SettingsGroup>

      {on && (
        <SettingsGroup
          title="Connect a client"
          icon="plug"
          description={
            <p>
              Copy a client's setup and run it in Terminal (or paste the JSON
              into the client's MCP settings).
            </p>
          }
        >
          <div
            className="settings-actions"
            role="group"
            aria-label="Copy client setup"
          >
            <Button
              icon="copy"
              onClick={() =>
                void copy(
                  "Claude Code command",
                  claudeCodeCommand(state.url, state.token),
                )
              }
            >
              Copy for Claude Code
            </Button>
            <Button
              icon="copy"
              onClick={() =>
                void copy(
                  "Codex commands",
                  codexCommands(state.url, state.token),
                )
              }
            >
              Copy for Codex
            </Button>
            <Button
              icon="copy"
              onClick={() =>
                void copy("JSON config", mcpJsonConfig(state.url, state.token))
              }
            >
              Copy JSON config
            </Button>
          </div>
          <p className="settings-hint" role="status" aria-live="polite">
            {copied ?? ""}
          </p>
          <SettingsRow
            label="Access token"
            hint={
              <p className="settings-hint">
                A new token locks out every client set up with the old one.
              </p>
            }
          >
            <Button
              icon="refresh"
              onClick={() => void regenerate()}
              disabled={busy}
            >
              New token
            </Button>
          </SettingsRow>
          <p className="settings-footnote">
            ChatGPT connectors run on OpenAI's servers, so they can't reach an
            app on your Mac.
          </p>
        </SettingsGroup>
      )}
    </>
  );
}
