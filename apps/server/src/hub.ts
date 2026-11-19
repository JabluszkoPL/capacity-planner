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
   */
  private push(peer: Peer, ops: Op[]): void {
    const accepted: StampedOp[] = [];

    this.db.transaction(() => {
      for (const op of ops) {
        if (!applyRemoteOp(this.db, op)) continue;
        const seq = appendToLog(this.db, op, peer.id);
        accepted.push({ ...op, seq });
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
