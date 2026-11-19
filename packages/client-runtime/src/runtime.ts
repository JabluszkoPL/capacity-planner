/**
 * PlannerRuntime — the seam between the React store and everything below it.
 *
 * The store's job is to hold an AppState and apply typed actions to it; it has
 * no business knowing about rows, HLC stamps or sockets. The runtime owns all
 * of that: a LocalStore for durability, a Clock for stamping, and (optionally)
 * a SyncClient for talking to other devices. Each app builds one of these from
 * its own platform pieces and hands it to the provider.
 *
 * Sync being optional is deliberate, not a fallback. Planner is perfectly
 * usable as a single-device app with no server anywhere, and that path should
 * not be a degraded version of the synced one — it is the same code with
 * `sync` left undefined.
 */
import { Clock, type Op } from "@planner/contracts";
import { diffStates } from "@planner/db";
import { seedState, type AppState } from "@planner/core";
import type { LocalStore } from "./localStore";
import { SyncClient, type SocketFactory, type SyncStatus } from "./syncClient";

export interface PlannerRuntimeOptions {
  store: LocalStore;
  /** Omit for a purely local, single-device app. */
  sync?: { url: string; socketFactory: SocketFactory };
  /** Seed the demo project into a database that has never held anything.
   *  Off for tests, on for a real first launch. */
  seedWhenEmpty?: boolean;
  /**
   * How long a sync-enabled device waits to hear from the server before
   * concluding it really is empty and seeding the demo project. Long enough for
   * a LAN round trip; short enough that a first launch with no server reachable
   * still shows something promptly.
   */
  seedWaitMs?: number;
}

const isEmpty = (s: AppState): boolean =>
  s.projects.length === 0 && s.teams.length === 0;

export class PlannerRuntime {
  readonly store: LocalStore;
  readonly clock: Clock;
  private readonly client: SyncClient | null;
  private readonly remoteListeners = new Set<() => void>();
  private readonly statusListeners = new Set<(s: SyncStatus) => void>();
  private status: SyncStatus = "offline";
  private readonly seedWhenEmpty: boolean;
  private readonly seedWaitMs: number;
  /** Memoised so concurrent callers share one load — React 18 StrictMode runs
   *  effects twice, and two loads racing on an empty database would each decide
   *  to seed it and produce two copies of the demo project. */
  private loading: Promise<AppState> | null = null;

  constructor(options: PlannerRuntimeOptions) {
    this.store = options.store;
    this.clock = new Clock(options.store.deviceId);
    this.seedWhenEmpty = options.seedWhenEmpty ?? false;
    this.seedWaitMs = options.seedWaitMs ?? 3000;
    this.client = options.sync
      ? new SyncClient({
          url: options.sync.url,
          store: options.store,
          socketFactory: options.sync.socketFactory,
          onChange: () => {
            for (const fn of this.remoteListeners) fn();
          },
          onStatus: (s) => {
            this.status = s;
            for (const fn of this.statusListeners) fn(s);
          },
        })
      : null;
  }

  get syncStatus(): SyncStatus {
    return this.status;
  }

  /** Whether this runtime talks to a server at all. */
  get syncEnabled(): boolean {
    return this.client !== null;
  }

  /**
   * The state to start the UI with, and the point at which sync begins.
   *
   * A database that has never held anything gets the demo project — but only on
   * a first launch, never after the user has deliberately emptied it, which is
   * why the check is "no rows at all" rather than "no projects".
   *
   * On a sync-enabled device the emptiness check cannot be made immediately:
   * a second machine added to an existing setup starts empty and would seed a
   * spurious "Sample Project" alongside the real data it is about to pull. So
   * when there is a server, we connect first and give it a moment to answer
   * before deciding. If it never answers, we seed anyway rather than leaving
   * the user staring at nothing.
   */
  load(): Promise<AppState> {
    return (this.loading ??= this.loadOnce());
  }

  private async loadOnce(): Promise<AppState> {
    this.start();

    const existing = await this.store.read();
    if (!isEmpty(existing) || !this.seedWhenEmpty) return existing;

    if (this.client) {
      await this.raceFirstSync();
      const afterSync = await this.store.read();
      if (!isEmpty(afterSync)) return afterSync;
    }

    await this.commit(existing, seedState());
    return this.store.read();
  }

  /** Wait for the first sync, but never longer than `seedWaitMs`. */
  private raceFirstSync(): Promise<void> {
    const client = this.client;
    if (!client) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, this.seedWaitMs);
      void client.whenFirstSettled().then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Persist the transition from one state to the next, and push it. */
  async commit(prev: AppState, next: AppState): Promise<Op[]> {
    const ops = diffStates(prev, next, this.clock);
    if (ops.length === 0) return ops;
    await this.store.applyLocal(ops);
    this.client?.push();
    return ops;
  }

  /** Re-read after remote ops landed. */
  read(): Promise<AppState> {
    return this.store.read();
  }

  onRemoteChange(fn: () => void): () => void {
    this.remoteListeners.add(fn);
    return () => void this.remoteListeners.delete(fn);
  }

  onStatusChange(fn: (status: SyncStatus) => void): () => void {
    this.statusListeners.add(fn);
    return () => void this.statusListeners.delete(fn);
  }

  start(): void {
    this.client?.start();
  }

  async stop(): Promise<void> {
    this.client?.stop();
    await this.store.close();
  }
}
