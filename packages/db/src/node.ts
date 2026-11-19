/**
 * `node:sqlite` driver — used by the sync server and by Electron's main
 * process. Kept in its own entry point (`@planner/db/node`) so that bundling
 * the web app never pulls a Node built-in into the browser graph.
 */
import { DatabaseSync } from "node:sqlite";
import type { SqlParams, SqliteDriver, SqlValue } from "./driver";

/** node:sqlite wants positional params spread, and named params as one object. */
function bind(params?: SqlParams): SqlValue[] {
  if (params === undefined) return [];
  return Array.isArray(params) ? params : [params as unknown as SqlValue];
}

export function openNodeDatabase(path: string): SqliteDriver {
  const db = new DatabaseSync(path);
  let depth = 0;

  return {
    exec(sql) {
      db.exec(sql);
    },
    all<T>(sql: string, params?: SqlParams) {
      return db.prepare(sql).all(...bind(params)) as T[];
    },
    get<T>(sql: string, params?: SqlParams) {
      return db.prepare(sql).get(...bind(params)) as T | undefined;
    },
    run(sql, params) {
      db.prepare(sql).run(...bind(params));
    },
    transaction<T>(fn: () => T): T {
      // Nested calls join the outer transaction rather than starting a second
      // one — SQLite has no nested BEGIN, and callers do batch at two levels
      // (clearPending inside a sync-apply batch).
      if (depth > 0) return fn();
      depth++;
      db.exec("BEGIN");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      } finally {
        depth--;
      }
    },
    close() {
      db.close();
    },
  };
}
