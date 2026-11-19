/**
 * The narrow slice of SQLite the app actually needs.
 *
 * Deliberately tiny, because it has to be implementable by three very different
 * things: `node:sqlite` (sync server + Electron main), and later `expo-sqlite`
 * or `op-sqlite` inside React Native. Anything richer — prepared-statement
 * caching, streaming, an ORM — would tie us to one of them.
 */
export type SqlValue = string | number | null | bigint | Uint8Array;
export type SqlParams = Record<string, SqlValue> | SqlValue[];

export interface SqliteDriver {
  /** Run one or more statements with no parameters and no result. */
  exec(sql: string): void;
  all<T = Record<string, SqlValue>>(sql: string, params?: SqlParams): T[];
  get<T = Record<string, SqlValue>>(
    sql: string,
    params?: SqlParams,
  ): T | undefined;
  run(sql: string, params?: SqlParams): void;
  /**
   * Run `fn` inside a transaction, committing on return and rolling back if it
   * throws. Must not be nested — callers batch at one level.
   */
  transaction<T>(fn: () => T): T;
  close(): void;
}

/** SQLite has no boolean type; these keep the intent readable at call sites. */
export const asInt = (b: boolean): number => (b ? 1 : 0);
export const asBool = (n: SqlValue | undefined): boolean => n === 1 || n === 1n;
