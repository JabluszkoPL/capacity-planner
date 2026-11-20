/**
 * The sync hub — all of the server's actual logic, with no socket in sight.
 *
 * Keeping it transport-free is what makes the protocol testable: the tests
 * drive a hub directly with decoded frames and assert on the frames it returns,
 * so a regression in merge or fan-out shows up without standing up a server.
 *
 * The hub is deliberately dumb. It never merges, rewrites or validates domain
 * shapes — it assigns each accepted op a global seq, stores it, and fans it
 * out. Every peer runs the same last-write-wins rule from @planner/db, so the
 * server holding a materialised copy of the state is a convenience (you can
 * open state.sqlite and read your plans) rather than an authority.
 */
import {
  PROTOCOL_VERSION,
  PULL_PAGE_SIZE,
  type ClientMessage,
  type Op,
  type ServerMessage,
  type StampedOp,
} from "@planner/contracts";
import {
  appendToLog,
  applyRemoteOp,
  headSeq,
  readOpsSince,
  type SqliteDriver,
} from "@planner/db";

/** One connected device, from the hub's point of view. */
export interface Peer {
  id: string;
  send(msg: ServerMessage): void;
}

export interface HubOptions {
  serverId: string;
  pageSize?: number;
  /** Where to report an op the store refused. Silent when absent. */
  log?: (line: string) => void;
}

export class Hub {
  private readonly peers = new Map<string, Peer>();
  private readonly pageSize: number;

  constructor(
    private readonly db: SqliteDriver,
    private readonly options: HubOptions,
  ) {
    this.pageSize = options.pageSize ?? PULL_PAGE_SIZE;
  }

  get connectionCount(): number {
    return this.peers.size;
  }

  head(): number {
    return headSeq(this.db);
  }

  connect(peer: Peer): void {
    this.peers.set(peer.id, peer);
  }

  disconnect(peerId: string): void {
    this.peers.delete(peerId);
  }

  /** Route one decoded client frame. Replies go through `peer.send`. */
  handle(peer: Peer, msg: ClientMessage): void {
    switch (msg.t) {
      case "hello": {
        if (msg.v !== PROTOCOL_VERSION) {
          peer.send({
            t: "error",
            code: "version_mismatch",
            message: `This server speaks protocol v${PROTOCOL_VERSION}, the client speaks v${msg.v}.`,
          });
          return;
        }
        peer.send({
          t: "welcome",
          v: PROTOCOL_VERSION,
          serverId: this.options.serverId,
          seq: this.head(),
        });
        this.sendPage(peer, msg.since);
        return;
      }
      case "pull":
        this.sendPage(peer, msg.since);
        return;
      case "push":
        this.push(peer, msg.ops);
        return;
      case "ping":
        peer.send({ t: "pong" });
        return;
    }
  }

  private sendPage(peer: Peer, since: number): void {
    // Ask for one extra row to learn whether another page exists, without a
    // second COUNT query.
    const batch = readOpsSince(this.db, since, this.pageSize + 1);
    const hasMore = batch.length > this.pageSize;
    const ops = hasMore ? batch.slice(0, this.pageSize) : batch;
    peer.send({
      t: "ops",
      ops,
      seq: ops.length > 0 ? ops[ops.length - 1].seq : since,
      hasMore,
    });
  }

  /**
   * Accept a batch of edits.
   *
   * Ops that lose the merge (an older stamp than the row already carries) are
   * counted as rejected and never reach the log — otherwise every reconnect
   * would grow the stream with ops that change nothing.
   *
   * An op the store throws on is rejected the same way, on its own. Each op
   * runs in a savepoint, so its half-written row and log entry roll back
   * while the rest of the batch commits and is acked. Failing the whole batch
   * instead would leave the client with no ack, resending the same batch on
   * every reconnect, and none of its edits — good or bad — would ever land.
   * The client drops a rejected op from its outbox just like a stale one (an
   * ack clears the whole batch), so one bad op can never stall a device.
   */
  private push(peer: Peer, ops: Op[]): void {
    const accepted: StampedOp[] = [];

    this.db.transaction(() => {
      for (const op of ops) {
        this.db.exec("SAVEPOINT push_op");
        try {
          if (applyRemoteOp(this.db, op)) {
            const seq = appendToLog(this.db, op, peer.id);
            accepted.push({ ...op, seq });
          }
          this.db.exec("RELEASE push_op");
        } catch (err) {
          this.db.exec("ROLLBACK TO push_op");
          this.db.exec("RELEASE push_op");
          this.options.log?.(
            `! ${peer.id} rejected ${op.entity} ${op.id}${op.deleted ? " (delete)" : ""}: ${(err as Error).message}`,
          );
        }
      }
    });

    peer.send({
      t: "ack",
      applied: accepted.length,
      rejected: ops.length - accepted.length,
      seq: this.head(),
    });

    if (accepted.length > 0) this.broadcast(peer.id, accepted);
  }

  /** Fan out to everyone except the device that sent the edit — it already has
   *  the change applied locally and is waiting only for the ack. */
  private broadcast(originId: string, ops: StampedOp[]): void {
    const frame: ServerMessage = {
      t: "ops",
      ops,
      seq: ops[ops.length - 1].seq,
      hasMore: false,
    };
    for (const [id, peer] of this.peers) {
      if (id === originId) continue;
      try {
        peer.send(frame);
      } catch {
        // A send failure means the socket is going away; the close handler
        // will unregister it. Never let one dead peer break a broadcast.
      }
    }
  }
}
