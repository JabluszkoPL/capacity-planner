import { useEffect, useId, useState } from "react";
import { Button } from "../ui/Button";
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

  return (
    <section className="about-section" aria-labelledby={`${id}-heading`}>
      <h4 id={`${id}-heading`}>AI assistants (MCP)</h4>
      <p className="about-status">
        Let Claude Code, Codex and other MCP clients on this Mac read your
        projects, plans, teams and Jira trackers while Planner is open, and open
        things in this window. Your Jira connection is never shared.
      </p>

      <label className="about-check">
        <input
          type="checkbox"
          checked={on}
          disabled={busy}
          onChange={(e) => void update({ enabled: e.target.checked })}
          aria-describedby={`${id}-status`}
        />
        <span>Allow AI clients to connect</span>
      </label>
      <label className="about-check">
        <input
          type="checkbox"
          checked={state.allowWrites}
          disabled={busy || !on}
          onChange={(e) => void update({ allowWrites: e.target.checked })}
          aria-describedby={`${id}-writes-hint`}
        />
        <span>Allow changes to projects, teams and days off</span>
      </label>
      <p className="modal-hint" id={`${id}-writes-hint`}>
        {state.allowWrites ? (
          <span className="about-warning">
            Clients can edit plans and people, and the edits sync to your other
            devices. There is no undo; nothing can be deleted.
          </span>
        ) : (
          "Off: clients can read and open things, but not change them."
        )}
      </p>
      <p
        className={`modal-hint${state.status === "error" ? " about-warning" : ""}`}
        id={`${id}-status`}
        role="status"
      >
        {statusLine(state)}
      </p>

      {on && (
        <>
          <p className="about-status">
            To connect a client, copy its setup and run it in Terminal (or paste
            the JSON into the client's MCP settings).
          </p>
          <div
            className="about-actions about-wrap"
            role="group"
            aria-label="Copy client setup"
          >
            <Button
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
              onClick={() =>
                void copy("JSON config", mcpJsonConfig(state.url, state.token))
              }
            >
              Copy JSON config
            </Button>
          </div>
          <p className="modal-hint" role="status" aria-live="polite">
            {copied ?? ""}
          </p>
          <div className="about-actions">
            <Button onClick={() => void regenerate()} disabled={busy}>
              New token
            </Button>
          </div>
          <p className="modal-hint">
            A new token locks out every client set up with the old one. ChatGPT
            connectors run on OpenAI's servers, so they can't reach an app on
            your Mac.
          </p>
        </>
      )}
    </section>
  );
}
