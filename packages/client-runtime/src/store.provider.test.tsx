// @vitest-environment jsdom
/**
 * The provider's persistence wiring: local edits must reach the database, and
 * remote ops must reach the screen. The reducer itself is covered exhaustively
 * in store.test.tsx; this file is only about the seam.
 */
import { describe, it, expect } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { Clock } from "@planner/contracts";
import type { AppState } from "@planner/core";
import { AppStoreProvider, useAppStore } from "./store";
import { PlannerRuntime } from "./runtime";
import { createMemoryLocalStore } from "./memoryLocalStore";
import type { LocalStore } from "./localStore";

async function makeRuntime(seedWhenEmpty = false) {
  const store = await createMemoryLocalStore({
    generateDeviceId: () => "dev-test",
  });
  return { runtime: new PlannerRuntime({ store, seedWhenEmpty }), store };
}

function Probe() {
  const { state, ready, syncStatus, syncEnabled, actions } = useAppStore();
  return (
    <div>
      <span data-testid="ready">{String(ready)}</span>
      <span data-testid="status">{syncStatus}</span>
      <span data-testid="enabled">{String(syncEnabled)}</span>
      <span data-testid="teams">
        {state.teams.map((t) => t.name).join(",")}
      </span>
      <span data-testid="projects">
        {state.projects.map((p) => p.name).join(",")}
      </span>
      <button onClick={() => actions.addTeam("Added Team")}>add team</button>
      <button
        onClick={() => actions.createProject("New Project", "2026-01-01")}
      >
        add project
      </button>
    </div>
  );
}

describe("AppStoreProvider", () => {
  it("loads from the local store before rendering data", async () => {
    const { runtime, store } = await makeRuntime();
    const clock = new Clock(store.deviceId);
    await store.applyLocal([
      {
        entity: "team",
        id: "t1",
        hlc: clock.tick(),
        deleted: false,
        data: { name: "Preloaded", position: 0 },
      },
    ]);

    render(
      <AppStoreProvider runtime={runtime}>
        <Probe />
      </AppStoreProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("ready")).toHaveTextContent("true"),
    );
    expect(screen.getByTestId("teams")).toHaveTextContent("Preloaded");
  });

  it("seeds the demo project only when asked and only when empty", async () => {
    const seeded = await makeRuntime(true);
    render(
      <AppStoreProvider runtime={seeded.runtime}>
        <Probe />
      </AppStoreProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("ready")).toHaveTextContent("true"),
    );
    expect(screen.getByTestId("projects")).toHaveTextContent("Sample Project");

    const bare = await makeRuntime(false);
    render(
      <AppStoreProvider runtime={bare.runtime}>
        <Probe />
      </AppStoreProvider>,
    );
    await waitFor(() => expect(bare.runtime.syncEnabled).toBe(false));
    expect(await bare.store.read()).toEqual({ projects: [], teams: [] });
  });

  it("seeds exactly once even when the load runs twice (StrictMode)", async () => {
    const { runtime, store } = await makeRuntime(true);
    // Both callers must observe the same single seed, not one each.
    const [first, second] = await Promise.all([runtime.load(), runtime.load()]);
    expect(first).toEqual(second);
    expect((await store.read()).projects).toHaveLength(1);
    expect((await store.read()).teams).toHaveLength(2);
  });

  it("writes a dispatched edit through to the local store", async () => {
    const { runtime, store } = await makeRuntime();
    render(
      <AppStoreProvider runtime={runtime}>
        <Probe />
      </AppStoreProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("ready")).toHaveTextContent("true"),
    );

    await act(async () => {
      screen.getByText("add team").click();
    });

    await waitFor(async () => {
      expect((await store.read()).teams.map((t) => t.name)).toEqual([
        "Added Team",
      ]);
    });
    // ...and it is queued for the server.
    expect((await store.pending()).length).toBeGreaterThan(0);
  });

  it("emits one op set per edit, not one per render", async () => {
    const { runtime, store } = await makeRuntime();
    render(
      <AppStoreProvider runtime={runtime}>
        <Probe />
      </AppStoreProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("ready")).toHaveTextContent("true"),
    );

    await act(async () => {
      screen.getByText("add team").click();
    });
    await waitFor(async () => expect((await store.pending()).length).toBe(1));

    // A re-render with no state change must not queue anything further.
    await act(async () => {});
    expect((await store.pending()).length).toBe(1);
  });

  it("adopts remote changes without diffing them back down", async () => {
    const { runtime, store } = await makeRuntime();
    render(
      <AppStoreProvider runtime={runtime}>
        <Probe />
      </AppStoreProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("ready")).toHaveTextContent("true"),
    );

    const remote = new Clock("dev-other");
    await act(async () => {
      await store.applyRemote(
        [
          {
            seq: 1,
            entity: "team",
            id: "t-remote",
            hlc: remote.tick(),
            deleted: false,
            data: { name: "From Another Device", position: 0 },
          },
        ],
        1,
      );
      // The runtime normally hears this from the sync client.
      await notifyRemote(runtime, store);
    });

    await waitFor(() =>
      expect(screen.getByTestId("teams")).toHaveTextContent(
        "From Another Device",
      ),
    );
    // Crucially, adopting a remote change must not re-queue it as a local edit.
    expect(await store.pending()).toEqual([]);
  });

  it("reports that sync is disabled when no server is configured", async () => {
    const { runtime } = await makeRuntime();
    render(
      <AppStoreProvider runtime={runtime}>
        <Probe />
      </AppStoreProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("ready")).toHaveTextContent("true"),
    );
    expect(screen.getByTestId("enabled")).toHaveTextContent("false");
    expect(screen.getByTestId("status")).toHaveTextContent("offline");
  });

  it("starts from `initial` without touching the store (test escape hatch)", async () => {
    const { runtime, store } = await makeRuntime();
    const initial: AppState = {
      projects: [],
      teams: [{ id: "t1", name: "Injected", members: [], offDays: {} }],
    };
    render(
      <AppStoreProvider runtime={runtime} initial={initial}>
        <Probe />
      </AppStoreProvider>,
    );
    expect(screen.getByTestId("teams")).toHaveTextContent("Injected");
    expect(await store.read()).toEqual({ projects: [], teams: [] });
  });
});

/** Fire the runtime's remote-change listeners the way SyncClient would. */
async function notifyRemote(
  runtime: PlannerRuntime,
  _store: LocalStore,
): Promise<void> {
  // onRemoteChange returns an unsubscribe; the listeners live on the runtime,
  // so triggering them means going through the same path the client uses.
  const fns = (runtime as unknown as { remoteListeners: Set<() => void> })
    .remoteListeners;
  for (const fn of fns) fn();
  await Promise.resolve();
}
