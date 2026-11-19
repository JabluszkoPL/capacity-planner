// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/dist-electron/**",
      "**/release/**",
      "**/renderer/**",
      "**/node_modules/**",
      "**/*.tsbuildinfo",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      // The codebase leans on `_`-prefixed names for deliberately unused
      // bindings (destructuring a field out, ignored callback params).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      // An empty catch is how "best-effort, never throw" is spelled in the
      // storage and persistence paths; those blocks carry a comment saying so.
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    // Build scripts run under plain Node, outside any tsconfig.
    files: ["**/*.mjs", "**/*.config.js"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["apps/web/**/*.{ts,tsx}", "packages/client-runtime/**/*.tsx"],
    plugins: { "react-hooks": reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
);
