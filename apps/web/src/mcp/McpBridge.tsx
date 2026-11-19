/**
 * Where AI clients' tool calls run: inside the open window, against its store.
 *
 * The Mac app's main process holds the MCP endpoint (its socket, token and
 * switches) and relays each call here as `{ name, args }`. This component
 * runs the tool from @planner/mcp on the live state and, for a change,
 * dispatches the tool's actions - the same typed actions a click dispatches -
 * so the edit is diffed, stamped, persisted and synced exactly like one made
 * by hand. It then waits for the store to take the new state before replying,
 * so a client's next call reads what it just wrote.
 *
 * Renders nothing, and does nothing outside the Mac app (`window.planner.mcp`
 * is absent in a browser tab). It reads nothing from the Jira settings: the
 * credentials never reach a tool.
 */
import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { reducer, useAppStore } from "@planner/client-runtime";
import { newId, todayISO, type AppState } from "@planner/core";
import { runTool, ToolError, type ToolContext } from "@planner/mcp";
import { hostBridge, type McpCallReply } from "../lib/hostBridge";
import { readTagAliases } from "../lib/tagAliases";
import { useToast } from "../components/ui/Toast";

/** Longest a reply waits for the store to take a change. */
const COMMIT_WAIT_MS = 2000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function McpBridge() {
  const mcp = hostBridge()?.mcp;
  const { state, ready, dispatch } = useAppStore();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();

  // Refs, so the call handler sees the latest of each without the bridge
  // re-registering with the main process on every render.
  const stateRef = useRef<AppState>(state);
  const pathRef = useRef(location.pathname);
  const navigateRef = useRef(navigate);
  const toastRef = useRef(toast);
  const waiters = useRef<(() => void)[]>([]);

  useEffect(() => {
    stateRef.current = state;
    const pending = waiters.current;
    waiters.current = [];
    for (const done of pending) done();
  }, [state]);
  useEffect(() => {
    pathRef.current = location.pathname;
  }, [location.pathname]);
  useEffect(() => {
    navigateRef.current = navigate;
    toastRef.current = toast;
  }, [navigate, toast]);

  useEffect(() => {
    if (!mcp || !ready) return;
    return mcp.serve(async (name, args, allowWrites): Promise<McpCallReply> => {
      try {
        const before = stateRef.current;
        const ctx: ToolContext = {
          state: before,
          today: todayISO(),
          now: new Date().toISOString(),
          newId,
          reduce: reducer,
          view: { path: pathRef.current },
          tagAliases: readTagAliases(),
        };
        const out = runTool(name, isRecord(args) ? args : {}, ctx, {
          allowWrites,
        });
        if (out.actions.length > 0) {
          const committed = new Promise<void>((resolve) => {
            waiters.current.push(resolve);
            setTimeout(resolve, COMMIT_WAIT_MS);
          });
          for (const action of out.actions) dispatch(action);
          await committed;
        }
        if (out.navigate && out.navigate !== pathRef.current) {
          navigateRef.current(out.navigate);
        }
        if (out.notice) toastRef.current(`AI assistant: ${out.notice}`);
        return { result: out.result };
      } catch (err) {
        if (err instanceof ToolError) return { error: err.message };
        console.error(`[mcp] ${name} failed`, err);
        return {
          error: `Planner could not run ${name}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
    });
  }, [mcp, ready, dispatch]);

  return null;
}
