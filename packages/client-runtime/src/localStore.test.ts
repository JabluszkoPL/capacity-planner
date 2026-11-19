import { describe, it, expect } from "vitest";
import { migrate } from "@planner/db";
import { openNodeDatabase } from "@planner/db/node";
import { createMemoryLocalStore } from "./memoryLocalStore";
import { createSqliteLocalStore } from "./sqliteLocalStore";
import { describeLocalStoreContract } from "./conformance";

let n = 0;

describeLocalStoreContract(
  "memory + no persistence",
  () => createMemoryLocalStore({ generateDeviceId: () => `dev-mem-${++n}` }),
  { describe, it, expect },
);

describeLocalStoreContract(
  "sqlite (node:sqlite, in-memory file)",
  async () => {
    const db = openNodeDatabase(":memory:");
    migrate(db);
    return createSqliteLocalStore(db, {
      generateDeviceId: () => `dev-sql-${++n}`,
    });
  },
  { describe, it, expect },
);
