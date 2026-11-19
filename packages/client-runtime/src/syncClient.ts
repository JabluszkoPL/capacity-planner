/**
 * The sync client: keeps a LocalStore in step with the server.
 *
 * Everything here is written so that the network is optional. The store is
 * always the thing the UI reads and writes; this client is a background process
 * that drains an outbox upward and merges ops downward. Disconnect the cable
 * and the app carries on — reconnect and the two ends reconcile from cursors,
 * with no "you have unsaved changes" dialog anywhere.
 *
 * The socket is injected rather than constructed. That is what lets the tests
 * run a full client/server conversation in-process, and what will let React
 * Native supply its own WebSocket without this file caring.
 */
import {
  PROTOCOL_VERSION,
  decodeServerMessage,
  encode,
  type ClientMessage,
  type ServerMessage,
} from "@planner/contracts";
import type { LocalStore } from "./localStore";

export type SyncStatus =
  /** No socket, and not trying — either never started or deliberately stopped. */
  | "offline"
  /** Socket opening, or waiting out a backoff delay before retrying. */
  | "connecting"
  /** Connected, still draining the backlog in one or both directions. */
  | "syncing"
  /** Connected and fully caught up. */
  | "live"
  /** The server refused us — a protocol mismatch. Retrying will not help. */
  | "incompatible";

export interface SocketHandlers {
  onOpen(): void;
  onMessage(data: string): void;
  onClose(): void;
  onError(error: unknown): void;
}

export interface SyncSocket {
  send(data: string): void;
  close(): void;
}

export type SocketFactory = (
  url: string,
  handlers: SocketHandlers,
) => SyncSocket;

export interface SyncClientOptions {
  url: string;
  store: LocalStore;
  socketFactory: SocketFactory;
  /** Called when remote ops changed the data, so the UI can re-read. */
  onChange?: () => void;
  onStatus?: (status: SyncStatus) => void;
  /** Reconnect backoff, doubling from first to max. */
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** Injected for tests; defaults to setTimeout. */
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

export class SyncClient {
  private socket: SyncSocket | null = null;
  /**
   * True only between the socket actually opening and it closing.
   *
   * `socket` being non-null is not enough: it is assigned the moment the
   * connection is *requested*, and a real WebSocket drops anything sent before
   * it opens. Pushing into that window used to mark the batch in flight and
   * then wait forever for an ack that could never come.
   */
  private ready = false;
  private status: SyncStatus = "offline";
  private stopped = true;
  private backoff: number;
  private retryHandle: unknown = null;
  /** Highest outbox seq currently in flight, cleared when the ack lands. */
  private inFlightThrough = 0;
  private knownServerId: string | null = null;

  /** Resolves the first time this client reaches a settled state — caught up,
   *  or told it can never be. Used to hold off the demo seed on a new device. */
  private firstSettled: Promise<void>;
  private resolveFirstSettled!: () => void;

  private readonly minBackoff: number;
  private readonly maxBackoff: number;
  private readonly schedule: (fn: () => void, ms: number) => unknown;
  private readonly cancel: (handle: unknown) => void;

  constructor(private readonly options: SyncClientOptions) {
    this.minBackoff = options.minBackoffMs ?? 500;
    this.maxBackoff = options.maxBackoffMs ?? 15_000;
    this.backoff = this.minBackoff;
    this.firstSettled = new Promise<void>((resolve) => {
      this.resolveFirstSettled = resolve;
    });
    this.schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancel = options.cancel ?? ((h) => clearTimeout(h as never));
  }

  getStatus(): SyncStatus {
    return this.status;
  }

  /**
   * Resolves once this client has caught up with the server for the first time
   * (or learned that it never will). Callers that need to know "is this device
   * actually empty, or has it just not heard yet?" wait on this — with their own
   * timeout, since a server that is simply unreachable never settles.
   */
  whenFirstSettled(): Promise<void> {
    return this.firstSettled;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.ready = false;
    if (this.retryHandle !== null) {
      this.cancel(this.retryHandle);
      this.retryHandle = null;
    }
    this.socket?.close();
    this.socket = null;
    this.setStatus("offline");
  }

  /** Ask the client to drain the outbox now — called after a local edit. */
  push(): void {
    void this.drainOutbox();
  }

  // ------------------------------------------------------------ internals --

  private setStatus(next: SyncStatus): void {
    if (this.status === next) return;
    this.status = next;
    if (next === "live" || next === "incompatible") this.resolveFirstSettled();
    this.options.onStatus?.(next);
  }

  private open(): void {
    if (this.stopped) return;
    this.setStatus("connecting");
    try {
      this.socket = this.options.socketFactory(this.options.url, {
        onOpen: () => void this.onOpen(),
        onMessage: (data) => void this.onMessage(data),
        onClose: () => this.onClose(),
        onError: () => {
          // A socket error is always followed by a close; let that path do the
          // retrying so we never schedule two reconnects for one failure.
        },
      });
    } catch {
      this.onClose();
    }
  }

  private onClose(): void {
    this.socket = null;
    this.ready = false;
    // Whatever was in flight was never acked; let it be picked up again.
    this.inFlightThrough = 0;
    if (this.stopped || this.status === "incompatible") return;
    this.setStatus("connecting");
    this.retryHandle = this.schedule(() => {
      this.retryHandle = null;
      this.open();
    }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, this.maxBackoff);
  }

  private send(msg: ClientMessage): void {
    this.socket?.send(encode(msg));
  }

  private async onOpen(): Promise<void> {
    this.ready = true;
    this.backoff = this.minBackoff;
    this.setStatus("syncing");
    this.send({
      t: "hello",
      v: PROTOCOL_VERSION,
      deviceId: this.options.store.deviceId,
      since: await this.options.store.cursor(),
    });
  }

  private async onMessage(raw: string): Promise<void> {
    const msg = decodeServerMessage(raw);
    if (!msg) return;
    await this.handle(msg);
  }

  private async handle(msg: ServerMessage): Promise<void> {
    switch (msg.t) {
      case "welcome": {
        // Seq numbers are only meaningful relative to one server's log. Talking
        // to a different server (a rebuilt box, a restored backup) means our
        // cursor points into a stream that no longer exists — start over rather
        // than silently skipping everything before it.
        if (
          this.knownServerId !== null &&
          this.knownServerId !== msg.serverId
        ) {
          await this.options.store.resetCursor();
        }
        this.knownServerId = msg.serverId;
        return;
      }

      case "ops": {
        const changed = await this.options.store.applyRemote(msg.ops, msg.seq);
        if (changed) this.options.onChange?.();
        if (msg.hasMore) {
          this.send({ t: "pull", since: await this.options.store.cursor() });
          return;
        }
        // Backlog drained downward; now drain upward.
        await this.drainOutbox();
        return;
      }

      case "ack": {
        if (this.inFlightThrough > 0) {
          await this.options.store.ackThrough(this.inFlightThrough);
          this.inFlightThrough = 0;
        }
        // More may have been queued while that batch was in flight.
        await this.drainOutbox();
        return;
      }

      case "error": {
        if (msg.code === "version_mismatch") {
          this.setStatus("incompatible");
          this.socket?.close();
          this.socket = null;
        }
        return;
      }

      case "pong":
        return;
    }
  }

  private async drainOutbox(): Promise<void> {
    if (!this.ready || !this.socket || this.stopped) return;
    // One batch in flight at a time: the ack tells us which outbox seqs to
    // drop, and overlapping pushes would make that bookkeeping ambiguous.
    if (this.inFlightThrough > 0) return;

    const pending = await this.options.store.pending();
    if (pending.length === 0) {
      this.setStatus("live");
      return;
    }
    this.setStatus("syncing");
    this.inFlightThrough = pending[pending.length - 1].seq;
    this.send({
      t: "push",
      ops: pending.map(({ seq: _seq, ...op }) => op),
    });
  }
}

/** The browser/Electron-renderer socket factory. */
export function webSocketFactory(
  url: string,
  handlers: SocketHandlers,
): SyncSocket {
  const ws = new WebSocket(url);
  ws.onopen = () => handlers.onOpen();
  ws.onmessage = (e: MessageEvent) => handlers.onMessage(String(e.data));
  ws.onclose = () => handlers.onClose();
  ws.onerror = (e: Event) => handlers.onError(e);
  return {
    send: (data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    },
    close: () => ws.close(),
  };
}
