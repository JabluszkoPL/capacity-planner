/**
 * @planner/db — the SQLite persistence and merge layer.
 *
 * Platform-neutral: everything here talks to the `SqliteDriver` interface, so
 * the same schema, the same merge rule, and the same AppState assembly run on
 * the server, in Electron, and (later) on a phone. The one Node-specific piece
 * lives behind the separate `@planner/db/node` entry point.
 */
export * from "./driver";
export * from "./schema";
export * from "./rows";
export * from "./assemble";
export * from "./apply";
export * from "./diff";
