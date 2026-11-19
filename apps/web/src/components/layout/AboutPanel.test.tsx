import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AppStoreProvider } from "@planner/client-runtime";
import type { UpdateState } from "@planner/core";
import { ToastProvider } from "../ui/Toast";
import { ConfirmProvider } from "../ui/ConfirmDialog";
import { Header } from "./Header";
import { __testing } from "../../lib/updates";
import { APP_VERSION } from "../../lib/appInfo";
import { SYNC_URL_KEY } from "../../lib/syncSettings";
import type { PlannerHost } from "../../lib/hostBridge";

function renderHeader() {
  return render(
    <ToastProvider>
      <ConfirmProvider>
        <AppStoreProvider initial={{ projects: [], teams: [] }}>
          <MemoryRouter>
            <Header />
          </MemoryRouter>
        </AppStoreProvider>
      </ConfirmProvider>
    </ToastProvider>,
  );
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

describe("version and updates in the header", () => {
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
    expect(screen.getByText(/localhost:5191/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Restart now" }));
    expect(install).toHaveBeenCalled();
  });
});

describe("sync settings in a browser", () => {
  it("rejects an unusable address without saving it", () => {
    renderHeader();
    fireEvent.click(screen.getByRole("button", { name: /About Planner/ }));
    fireEvent.change(screen.getByLabelText("Sync server"), {
      target: { value: "ftp://nope" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/server address/);
    expect(localStorage.getItem(SYNC_URL_KEY)).toBeNull();
  });
});
