/**
 * The client/server wire protocol.
 *
 * One WebSocket, JSON frames, discriminated on `t`. The server is a relay with
 * a durable log: it never merges or rewrites, it only assigns each accepted op
 * a global `seq` and fans it out. All conflict resolution is last-write-wins by
 * HLC and happens identically on every peer, which is what lets a client apply
 * its own edit optimistically and stay consistent with the server's eventual
 * ordering.
 */
import type { Op, StampedOp } from "./entities";
import { isOp } from "./entities";

export const PROTOCOL_VERSION = 1;

/** Max ops the server will return in a single `ops` frame. */
export const PULL_PAGE_SIZE = 500;

export type ClientMessage =
  /** First frame on every connection. `since` is the last seq this device
   *  durably applied; the server replies with everything after it. */
  | { t: "hello"; v: number; deviceId: string; since: number }
  | { t: "push"; ops: Op[] }
  | { t: "pull"; since: number }
  | { t: "ping" };

export type ServerMessage =
  | { t: "welcome"; v: number; serverId: string; seq: number }
  /** A batch of ops with seq > the client's cursor, oldest first. */
  | { t: "ops"; ops: StampedOp[]; seq: number; hasMore: boolean }
  /** Confirms a push landed. `seq` is the server's head after applying it. */
  | { t: "ack"; applied: number; rejected: number; seq: number }
  | { t: "error"; code: ErrorCode; message: string }
  | { t: "pong" };

export type ErrorCode =
  "bad_message" | "version_mismatch" | "not_ready" | "internal";

export function encode(msg: ClientMessage | ServerMessage): string {
  return JSON.stringify(msg);
}

/** Parse an untrusted frame from the socket. Returns null on anything
 *  malformed — a bad frame is a protocol error, never a thrown exception. */
export function decodeClientMessage(raw: string): ClientMessage | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const m = v as Record<string, unknown>;
  switch (m.t) {
    case "hello":
      return typeof m.v === "number" &&
        typeof m.deviceId === "string" &&
        m.deviceId.length > 0 &&
        typeof m.since === "number" &&
        Number.isInteger(m.since) &&
        m.since >= 0
        ? { t: "hello", v: m.v, deviceId: m.deviceId, since: m.since }
        : null;
    case "push":
      return Array.isArray(m.ops) && m.ops.every(isOp)
        ? { t: "push", ops: m.ops as Op[] }
        : null;
    case "pull":
      return typeof m.since === "number" &&
        Number.isInteger(m.since) &&
        m.since >= 0
        ? { t: "pull", since: m.since }
        : null;
    case "ping":
      return { t: "ping" };
    default:
      return null;
  }
}

export function decodeServerMessage(raw: string): ServerMessage | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const m = v as Record<string, unknown>;
  switch (m.t) {
    case "welcome":
      return typeof m.v === "number" &&
        typeof m.serverId === "string" &&
        typeof m.seq === "number"
        ? { t: "welcome", v: m.v, serverId: m.serverId, seq: m.seq }
        : null;
    case "ops": {
      if (!Array.isArray(m.ops)) return null;
      const ops = m.ops.filter(
        (o): o is StampedOp =>
          isOp(o) && typeof (o as { seq?: unknown }).seq === "number",
      );
      if (ops.length !== m.ops.length) return null;
      return typeof m.seq === "number"
        ? { t: "ops", ops, seq: m.seq, hasMore: m.hasMore === true }
        : null;
    }
    case "ack":
      return typeof m.applied === "number" &&
        typeof m.rejected === "number" &&
        typeof m.seq === "number"
        ? { t: "ack", applied: m.applied, rejected: m.rejected, seq: m.seq }
        : null;
    case "error":
      return typeof m.message === "string"
        ? {
            t: "error",
            code: (m.code as ErrorCode) ?? "internal",
            message: m.message,
          }
        : null;
    case "pong":
      return { t: "pong" };
    default:
      return null;
  }
}
