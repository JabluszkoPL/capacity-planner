import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AppStoreProvider } from "@planner/client-runtime";
import type { UpdateState } from "@planner/core";
import { ToastProvider } from "../ui/Toast";
import { ConfirmProvider } from "../ui/ConfirmDialog";
import { Sidebar } from "./Sidebar";
import { __testing } from "../../lib/updates";
import { APP_VERSION } from "../../lib/appInfo";
import { SYNC_URL_KEY } from "../../lib/syncSettings";
import { THEME_KEY } from "../../lib/theme";
import type { PlannerHost } from "../../lib/hostBridge";

function renderHeader() {
  return render(
    <ToastProvider>
      <ConfirmProvider>
        <AppStoreProvider initial={{ projects: [], teams: [] }}>
          <MemoryRouter>
            <Sidebar />
          </MemoryRouter>
        </AppStoreProvider>
      </ConfirmProvider>
    </ToastProvider>,
  );
}

/** The settings dialog shows one section at a time; pick one. */
function openSection(name: string) {
  fireEvent.click(screen.getByRole("tab", { name }));
}

function release(version: string) {
  return {
    tag_name: `v${version}`,
    html_url: `https://github.com/JabluszkoPL/capacity-planner/releases/tag/v${version}`,
    body: "",
    assets: [],
  };
}

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

beforeEach(() => {
  localStorage.clear();
  __testing.reset();
});

afterEach(() => {
  delete window.planner;
});

describe("version and updates in the sidebar", () => {
  it("shows the build's version and opens the About panel", () => {
    renderHeader();
    const button = screen.getByRole("button", {
      name: new RegExp(`v${APP_VERSION}`),
    });
    fireEvent.click(button);
    expect(
      screen.getByRole("dialog", { name: "About Planner" }),
    ).toBeInTheDocument();
    expect(screen.getByText(APP_VERSION)).toBeInTheDocument();
  });

  it("announces a newer release found by the browser check", async () => {
    const fetchImpl = vi.fn(async () => okResponse(release("99.0.0")));
    await __testing.browserCheck(fetchImpl as unknown as typeof fetch);
    renderHeader();
    const button = screen.getByRole("button", { name: /Update to v99\.0\.0/ });
    fireEvent.click(button);
    expect(
      screen.getByText(/Version 99\.0\.0 is available/),
    ).toBeInTheDocument();
    // A browser can't install; it links to the release instead.
    expect(
      screen.getByRole("link", { name: "Get it on GitHub" }),
    ).toHaveAttribute("href", expect.stringContaining("/releases/tag/v99.0.0"));
  });

  it("treats an older or equal release as up to date", async () => {
    const fetchImpl = vi.fn(async () => okResponse(release(APP_VERSION)));
    await __testing.browserCheck(fetchImpl as unknown as typeof fetch);
    expect(__testing.state.status).toBe("up-to-date");
  });

  it("treats a repository with no releases yet as up to date", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 404 }));
    await __testing.browserCheck(fetchImpl as unknown as typeof fetch);
    expect(__testing.state.status).toBe("up-to-date");
  });

  it("mirrors the Mac app's updater and installs from it", async () => {
    let push: (s: UpdateState) => void = () => {};
    const ready: UpdateState = {
      status: "ready",
      currentVersion: APP_VERSION,
      latest: {
        version: "99.0.0",
        pageUrl: "https://github.com/x/y",
        notes: "",
      },
      progress: 1,
      canInstall: true,
      message: null,
      checkedAt: null,
    };
    const install = vi.fn(async () => ready);
    window.planner = {
      db: {} as PlannerHost["db"],
      syncUrl: null,
      platform: "darwin",
      version: "38",
      updates: {
        state: async () => ({ ...ready, status: "idle", latest: null }),
        check: async () => ready,
        download: async () => ready,
        install,
        onChange: (fn) => {
          push = fn;
          return () => {};
        },
      },
      share: { url: "http://localhost:5191", open: async () => {} },
    };
    renderHeader();
    await act(async () => push(ready));
    fireEvent.click(screen.getByRole("button", { name: /Restart to update/ }));
    fireEvent.click(screen.getByRole("button", { name: "Restart now" }));
    expect(install).toHaveBeenCalled();
    openSection("Sync & sharing");
    expect(screen.getByText(/localhost:5191/)).toBeVisible();
  });
});

describe("settings sections", () => {
  it("is a vertical tablist that moves with the arrow keys", () => {
    renderHeader();
    fireEvent.click(screen.getByRole("button", { name: /About Planner/ }));
    const list = screen.getByRole("tablist", { name: "Settings sections" });
    expect(list).toHaveAttribute("aria-orientation", "vertical");
    const tabs = screen.getAllByRole("tab").map((t) => t.textContent);
    // AI assistants is the Mac app's; a browser tab doesn't offer it.
    expect(tabs).toEqual(["General", "Sync & sharing", "Backup", "About"]);

    const general = screen.getByRole("tab", { name: "General" });
    expect(general).toHaveFocus();
    expect(general).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveAccessibleName("General");
    expect(
      screen.getByRole("button", { name: "Check for updates" }),
    ).toBeVisible();

    fireEvent.keyDown(general, { key: "ArrowDown" });
    const sync = screen.getByRole("tab", { name: "Sync & sharing" });
    expect(sync).toHaveFocus();
    expect(sync).toHaveAttribute("aria-selected", "true");
    expect(sync).toHaveAttribute("tabindex", "0");
    expect(general).toHaveAttribute("aria-selected", "false");
    expect(general).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("tabpanel")).toHaveAccessibleName("Sync & sharing");
    expect(screen.queryByRole("button", { name: "Check for updates" })).toBe(
      null,
    );

    fireEvent.keyDown(sync, { key: "End" });
    expect(screen.getByRole("tab", { name: "About" })).toHaveFocus();
    expect(
      screen.getByRole("link", { name: "Source on GitHub" }),
    ).toBeVisible();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(general).toHaveFocus();
    fireEvent.keyDown(general, { key: "ArrowUp" });
    expect(screen.getByRole("tab", { name: "About" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(general).toHaveFocus();
  });

  it("keeps a half-typed sync address while looking at another section", () => {
    renderHeader();
    fireEvent.click(screen.getByRole("button", { name: /About Planner/ }));
    openSection("Sync & sharing");
    fireEvent.change(screen.getByLabelText("Sync server"), {
      target: { value: "mac.local:5191" },
    });
    openSection("Backup");
    expect(
      screen.getByRole("button", { name: "Export everything" }),
    ).toBeVisible();
    openSection("Sync & sharing");
    expect(screen.getByLabelText("Sync server")).toHaveValue("mac.local:5191");
  });
});

describe("sync settings in a browser", () => {
  it("rejects an unusable address without saving it", () => {
    renderHeader();
    fireEvent.click(screen.getByRole("button", { name: /About Planner/ }));
    openSection("Sync & sharing");
    fireEvent.change(screen.getByLabelText("Sync server"), {
      target: { value: "ftp://nope" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/server address/);
    expect(localStorage.getItem(SYNC_URL_KEY)).toBeNull();
  });
});

describe("sharing in the Mac app", () => {
  function host(share: PlannerHost["share"]) {
    const idle: UpdateState = {
      status: "idle",
      currentVersion: APP_VERSION,
      latest: null,
      progress: null,
      canInstall: false,
      message: null,
      checkedAt: null,
    };
    window.planner = {
      db: {} as PlannerHost["db"],
      syncUrl: null,
      platform: "darwin",
      version: "38",
      updates: {
        state: async () => idle,
        check: async () => idle,
        download: async () => idle,
        install: async () => idle,
        onChange: () => () => {},
      },
      share,
    };
  }

  it("explains when the browser shows another server's older version", () => {
    host({
      url: "http://localhost:5191",
      foreignVersion: "0.0.1",
      open: async () => {},
    });
    renderHeader();
    fireEvent.click(screen.getByRole("button", { name: /About Planner/ }));
    openSection("Sync & sharing");
    const note = screen.getByRole("note");
    expect(note).toHaveTextContent("Another Planner server (v0.0.1)");
    expect(note).toHaveTextContent(`not v${APP_VERSION}`);
    expect(note).toHaveTextContent("pnpm dev");
  });

  it("says nothing extra when the app runs its own server", () => {
    host({ url: "http://localhost:5191", open: async () => {} });
    renderHeader();
    fireEvent.click(screen.getByRole("button", { name: /About Planner/ }));
    openSection("Sync & sharing");
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("offers the AI assistants section when the app serves MCP", async () => {
    host({ url: "http://localhost:5191", open: async () => {} });
    const mcpState = {
      enabled: false,
      allowWrites: false,
      token: "t".repeat(43),
      url: "http://127.0.0.1:5192/mcp",
      status: "off" as const,
    };
    window.planner!.mcp = {
      state: async () => mcpState,
      update: async () => mcpState,
      regenerateToken: async () => mcpState,
      onChange: () => () => {},
      serve: () => () => {},
    };
    renderHeader();
    fireEvent.click(screen.getByRole("button", { name: /About Planner/ }));
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([
      "General",
      "Sync & sharing",
      "Backup",
      "AI assistants",
      "About",
    ]);
    openSection("AI assistants");
    expect(
      await screen.findByRole("checkbox", {
        name: "Allow AI clients to connect",
      }),
    ).toBeVisible();
  });
});

describe("appearance", () => {
  it("switches the theme from General and remembers it on this device", () => {
    renderHeader();
    fireEvent.click(
      screen.getByRole("button", { name: new RegExp(`v${APP_VERSION}`) }),
    );
    const theme = screen.getByRole("radiogroup", { name: "Theme" });
    expect(
      within(theme).getByRole("radio", { name: "System" }),
    ).toHaveAttribute("aria-checked", "true");
    fireEvent.click(within(theme).getByRole("radio", { name: "Dark" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem(THEME_KEY)).toBe("dark");
    fireEvent.click(within(theme).getByRole("radio", { name: "System" }));
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });
});
