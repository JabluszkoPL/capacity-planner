import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Only the pure parts are testable here: everything else in electron/ needs
    // a running Electron. The Jira guard is exactly the kind of pure rule that
    // must not be verified by hand.
    include: ["electron/**/*.test.ts"],
  },
});
