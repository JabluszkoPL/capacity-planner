import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "../ui/Toast";
import { McpSection } from "./McpSection";
import type { McpHostState, PlannerMcpBridge } from "../../lib/hostBridge";

const TOKEN = "t".repeat(43);

function fakeMcp(initial: Partial<McpHostState> = {}) {
  let state: McpHostState = {
    enabled: false,
    allowWrites: false,
    token: TOKEN,
    url: "http://127.0.0.1:5192/mcp",
    status: "off",
    ...initial,
  };
  const listeners = new Set<(s: McpHostState) => void>();
  const bridge: PlannerMcpBridge = {
    state: vi.fn(async () => state),
    update: vi.fn(async (patch) => {
      state = {
        ...state,
        ...patch,
        status: (patch.enabled ?? state.enabled) ? "listening" : "off",
      };
      return state;
    }),
    regenerateToken: vi.fn(async () => {
      state = { ...state, token: "n".repeat(43) };
      return state;
    }),
    onChange: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    serve: () => () => {},
  };
  return { bridge, push: (s: McpHostState) => listeners.forEach((f) => f(s)) };
}

function install(bridge: PlannerMcpBridge) {
  window.planner = {
    db: {} as never,
    syncUrl: null,
    platform: "darwin",
    version: "38",
    mcp: bridge,
  };
}

function renderSection() {
  return render(
    <ToastProvider>
      <McpSection />
    </ToastProvider>,
  );
}

afterEach(() => {
  delete window.planner;
});

describe("AI assistants settings", () => {
  it("is absent in a browser tab", () => {
    const { container } = renderSection();
    expect(container).toBeEmptyDOMElement();
  });

  it("starts off, with changes off and unavailable until connecting is on", async () => {
    const { bridge } = fakeMcp();
    install(bridge);
    renderSection();
    const connect = await screen.findByRole("checkbox", {
      name: "Allow AI clients to connect",
    });
    const writes = screen.getByRole("checkbox", {
      name: "Allow changes to projects, teams and days off",
    });
    expect(connect).not.toBeChecked();
    expect(writes).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Off.");
    expect(screen.queryByRole("button", { name: /Copy/ })).toBeNull();
  });

  it("turns on from the keyboard and offers the install commands", async () => {
    const user = userEvent.setup();
    const { bridge } = fakeMcp();
    install(bridge);
    renderSection();
    const connect = await screen.findByRole("checkbox", {
      name: "Allow AI clients to connect",
    });
    connect.focus();
    await user.keyboard(" ");
    expect(bridge.update).toHaveBeenCalledWith({ enabled: true });
    expect(
      await screen.findByText(/Listening at http:\/\/127\.0\.0\.1:5192\/mcp/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", {
        name: "Allow changes to projects, teams and days off",
      }),
    ).toBeEnabled();

    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    await user.click(
      screen.getByRole("button", { name: "Copy for Claude Code" }),
    );
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining(`--header "Authorization: Bearer ${TOKEN}"`),
    );
    expect(
      screen.getByText(/Copied the Claude Code command/),
    ).toBeInTheDocument();
    // The token itself is never printed on screen.
    expect(document.body.textContent).not.toContain(TOKEN);
  });

  it("warns when changes are allowed, and makes a new token on request", async () => {
    const user = userEvent.setup();
    const { bridge } = fakeMcp({ enabled: true, status: "listening" });
    install(bridge);
    renderSection();
    await user.click(
      await screen.findByRole("checkbox", {
        name: "Allow changes to projects, teams and days off",
      }),
    );
    expect(bridge.update).toHaveBeenCalledWith({ allowWrites: true });
    expect(await screen.findByText(/There is no undo/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "New token" }));
    expect(bridge.regenerateToken).toHaveBeenCalled();
    expect(await screen.findByText(/New token made/)).toBeInTheDocument();
  });

  it("shows why the server could not start", async () => {
    const { bridge, push } = fakeMcp({ enabled: true, status: "listening" });
    install(bridge);
    renderSection();
    await screen.findByText(/Listening/);
    act(() =>
      push({
        enabled: true,
        allowWrites: false,
        token: TOKEN,
        url: "http://127.0.0.1:5192/mcp",
        status: "error",
        error: "Port 5192 is already in use.",
      }),
    );
    expect(
      screen.getByText("Port 5192 is already in use."),
    ).toBeInTheDocument();
  });
});
