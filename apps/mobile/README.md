# apps/mobile — reserved

Nothing here yet. This folder is the shape of the argument that the monorepo was
worth the trouble: when the iOS and Android apps get built, almost none of the
work below this line has to change.

## What is already done for mobile

- **The domain.** `@planner/core` has no React, no DOM and no Node built-ins.
  The scheduler, the timeline layout and the exporters run unmodified on a phone.
- **The database.** `@planner/db` talks to a five-method `SqliteDriver`
  interface. A mobile driver is that interface implemented over `expo-sqlite` or
  `op-sqlite` — roughly the size of `packages/db/src/node.ts`, about 40 lines.
  The schema, the migrations and the merge rule are shared as-is.
- **Sync.** `SyncClient` takes an injected socket factory; React Native's
  `WebSocket` satisfies it directly. The protocol and the clock are already
  platform-neutral.
- **The store.** The reducer and every action in `@planner/client-runtime` are
  UI-agnostic. `AppStoreProvider` uses React, not React DOM, so it works in
  React Native unchanged.

## What actually has to be written

The UI, and only the UI. `apps/web` is 33 components, 3 routes and ~1,800 lines
of CSS built on DOM primitives and CSS grid; none of that translates. The Gantt
timeline in particular is a CSS-grid date lattice and would need rebuilding on
React Native primitives (or `react-native-skia` for the bars).

Two web-only libraries also need native replacements: `planImage.ts` draws the
PNG export on a `<canvas>`, and `download.ts` hands bytes to the browser — on a
phone those become a Skia surface and the share sheet.

## The plan, when the time comes

Follow t3code: Expo, `expo-sqlite`, React Navigation, EAS for builds.

1. `apps/mobile` as an Expo app in this workspace. pnpm is already configured
   with `node-linker=hoisted` in `.npmrc`, which is what Metro needs.
2. `packages/db/src/expo.ts` — `SqliteDriver` over `expo-sqlite`.
3. Reuse `createSqliteLocalStore` and `PlannerRuntime` verbatim.
4. Build the screens.

Point it at a `PLANNER_SYNC_URL` on the machine running `pnpm dev:server` and
the phone converges with the Mac app.
