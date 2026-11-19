/**
 * App versions and published releases.
 *
 * Planner is released as GitHub releases tagged `v<semver>`. Both hosts ask
 * "is there something newer than me?": the Mac app's main process (which can
 * then download and install it) and a browser tab (which can only say so).
 * The answer must be identical in both, so the parsing and the comparison live
 * here, pure, and each host brings its own `fetch`.
 *
 * Only plain `MAJOR.MINOR.PATCH` with an optional `-prerelease` is understood.
 * A tag that doesn't parse is treated as "not newer" — an update check must
 * never nag about a release it cannot reason about.
 */

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated prerelease identifiers; empty for a normal release. */
  pre: string[];
}

const VERSION_RE =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(input: string): ParsedVersion | null {
  const m = VERSION_RE.exec(input.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? m[4].split(".") : [],
  };
}

/** Semver precedence: negative if `a < b`, positive if `a > b`, 0 if equal. */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  // A release outranks any of its own prereleases.
  if (a.pre.length === 0 || b.pre.length === 0) {
    return b.pre.length - a.pre.length;
  }
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (Number(x) !== Number(y)) return Number(x) - Number(y);
    } else if (xn !== yn) {
      return xn ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** True only when both parse and `candidate` is strictly newer. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const c = parseVersion(candidate);
  const k = parseVersion(current);
  if (!c || !k) return false;
  return compareVersions(c, k) > 0;
}

/**
 * `owner/repo` from whatever a package.json `repository` field holds:
 * "github:owner/repo", "owner/repo", or a github.com URL (https, git+https,
 * ssh), with or without `.git`.
 */
export function githubRepoSlug(repository: unknown): string | null {
  const raw =
    typeof repository === "string"
      ? repository
      : typeof repository === "object" && repository !== null
        ? (repository as { url?: unknown }).url
        : undefined;
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  const patterns = [
    /^github:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/,
    /^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/,
    /^(?:git\+)?https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/,
    /^(?:git\+)?ssh:\/\/git@github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?$/,
    /^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/,
  ];
  for (const re of patterns) {
    const m = re.exec(s);
    if (m) return `${m[1]}/${m[2]}`;
  }
  return null;
}

/** The one API call either host makes. Fixed host, fixed shape. */
export function latestReleaseApiUrl(repoSlug: string): string {
  return `https://api.github.com/repos/${repoSlug}/releases/latest`;
}

export function releasesPageUrl(repoSlug: string): string {
  return `https://github.com/${repoSlug}/releases`;
}

export interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
  /** Hex SHA-256 when GitHub reports a digest for the asset. */
  sha256: string | null;
}

export interface LatestRelease {
  /** Version without the leading `v`, e.g. "0.2.0". */
  version: string;
  tag: string;
  /** The release's page on github.com, for "what's new". */
  pageUrl: string;
  /** Release notes as written (Markdown), possibly empty. */
  notes: string;
  publishedAt: string | null;
  /** The universal macOS .zip, which is what the Mac app installs from. */
  macZip: ReleaseAsset | null;
  /** The .dmg, for people downloading by hand. */
  macDmg: ReleaseAsset | null;
}

/**
 * Read GitHub's `releases/latest` response. Drafts and prereleases are never
 * returned by that endpoint, but they are rejected here too in case a caller
 * passes an entry from the full list.
 *
 * Asset URLs are only accepted when they point into this repository's own
 * release downloads — the Mac app executes what it downloads, so a release
 * body that somehow named another host must not be followed.
 */
export function parseLatestRelease(
  body: unknown,
  repoSlug: string,
): LatestRelease | null {
  if (typeof body !== "object" || body === null) return null;
  const r = body as Record<string, unknown>;
  if (r.draft === true || r.prerelease === true) return null;
  const tag = typeof r.tag_name === "string" ? r.tag_name : "";
  const parsed = parseVersion(tag);
  if (!parsed) return null;
  const version = tag.replace(/^v/, "");

  const assetPrefix = `https://github.com/${repoSlug}/releases/download/`;
  const assets: ReleaseAsset[] = [];
  if (Array.isArray(r.assets)) {
    for (const a of r.assets) {
      if (typeof a !== "object" || a === null) continue;
      const v = a as Record<string, unknown>;
      const name = typeof v.name === "string" ? v.name : "";
      const url =
        typeof v.browser_download_url === "string"
          ? v.browser_download_url
          : "";
      const size = typeof v.size === "number" ? v.size : 0;
      if (!name || !url.startsWith(assetPrefix) || size <= 0) continue;
      const digest = typeof v.digest === "string" ? v.digest : "";
      const sha = /^sha256:([0-9a-f]{64})$/i.exec(digest);
      assets.push({
        name,
        url,
        size,
        sha256: sha ? sha[1]!.toLowerCase() : null,
      });
    }
  }

  const htmlUrl = typeof r.html_url === "string" ? r.html_url : "";
  return {
    version,
    tag,
    pageUrl: htmlUrl.startsWith(`https://github.com/${repoSlug}/`)
      ? htmlUrl
      : releasesPageUrl(repoSlug),
    notes: typeof r.body === "string" ? r.body : "",
    publishedAt: typeof r.published_at === "string" ? r.published_at : null,
    macZip: assets.find((a) => /-mac\.zip$/i.test(a.name)) ?? null,
    macDmg: assets.find((a) => /\.dmg$/i.test(a.name)) ?? null,
  };
}

/** Where an update check stands, as shown to the user. */
export type UpdateStatus =
  /** Not checked yet. */
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  /** Mac app only: fetching the new build. */
  | "downloading"
  /** Mac app only: downloaded and verified, waiting for a restart. */
  | "ready"
  | "error";

export interface UpdateState {
  status: UpdateStatus;
  currentVersion: string;
  latest: { version: string; pageUrl: string; notes: string } | null;
  /** 0..1 while downloading, otherwise null. */
  progress: number | null;
  /** Whether this host can download and install the update by itself. A
   *  browser tab never can; the Mac app can when it is installed somewhere it
   *  is allowed to replace. */
  canInstall: boolean;
  /** What went wrong, or why installing isn't possible here. */
  message: string | null;
  /** ISO timestamp of the last completed check. */
  checkedAt: string | null;
}

export function initialUpdateState(currentVersion: string): UpdateState {
  return {
    status: "idle",
    currentVersion,
    latest: null,
    progress: null,
    canInstall: false,
    message: null,
    checkedAt: null,
  };
}
