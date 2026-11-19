/**
 * @planner/contracts — the shared vocabulary between every client and the sync
 * server: what a synced row is, how edits are stamped and ordered, and what
 * goes over the socket. Depends on nothing (not even @planner/core) so that the
 * server never has to link the scheduling engine just to relay a row.
 */
export * from "./hlc";
export * from "./entities";
export * from "./protocol";
