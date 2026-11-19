/**
 * What this build is: its version and where its releases are published. Both
 * come from the workspace root package.json at build time (vite.config.ts), so
 * `pnpm version:set` is the only place a release changes them.
 */
import { githubRepoSlug, releasesPageUrl } from "@planner/core";

export const APP_VERSION: string = __PLANNER_VERSION__;

/** `owner/repo` on GitHub, or null for a build with no repository set. */
export const RELEASES_REPO: string | null = githubRepoSlug(
  __PLANNER_REPOSITORY__,
);

export const RELEASES_URL: string | null = RELEASES_REPO
  ? releasesPageUrl(RELEASES_REPO)
  : null;

export const REPO_URL: string | null = RELEASES_REPO
  ? `https://github.com/${RELEASES_REPO}`
  : null;
