/**
 * A full backup: everything in `AppState` plus this device's own settings, in
 * one file, so moving from a browser to the Mac app (or between machines that
 * do not share a sync server) is one export and one import.
 *
 * The file is an ordinary Planner export — `projects`, `teams`, `trackers` at
 * the top level — with one extra `device` key. The dashboard's Import reads it
 * like any other export and simply ignores `device`; only the backup import in
 * the About panel applies it.
 *
 * `device` holds what lives in localStorage rather than `AppState`: the Jira
 * connection and the remembered tag mappings. The Jira API token is the reason
 * those settings stay out of `AppState` (see `jiraSettings.ts`), and it is the
 * reason it is in this file only when the user ticks a box saying so. Even
 * then it never enters `AppState`: {@link parseBackup} splits the file in two
 * before anything reaches the store, so the token cannot be diffed into ops,
 * synced, or written into a later export.
 *
 * `allowWrites` is never carried. Writing to Jira is off by default on every
 * device and is switched on where it is wanted, not inherited from a file.
 */
import {
  parseImportedState,
  serializeState,
  type AppState,
} from "@planner/core";
import type { TagAlias } from "@planner/jira";
import {
  DEFAULT_HOURS_PER_DAY,
  isJiraConfigured,
  readJiraSettings,
  writeJiraSettings,
  type JiraSettings,
} from "./jiraSettings";
import { readTagAliases, writeTagAliases } from "./tagAliases";

export const DEVICE_BACKUP_VERSION = 1;

/** The Jira connection as it travels in a backup. */
export interface JiraBackup {
  baseUrl: string;
  email: string;
  /** Present only when the user chose to include it. */
  apiToken?: string;
  hoursPerDay: number;
  orgId?: string;
}

export interface DeviceBackup {
  version: number;
  jira?: JiraBackup;
  tagAliases?: TagAlias[];
}

export interface ParsedBackup {
  state: AppState;
  /** Null for a plain export, which carries no device settings. */
  device: DeviceBackup | null;
}

/** The Jira part of a backup, or nothing when Jira isn't set up here. */
export function jiraBackup(
  settings: JiraSettings,
  includeToken: boolean,
): JiraBackup | undefined {
  if (settings.baseUrl.trim() === "" && settings.email.trim() === "") {
    return undefined;
  }
  return {
    baseUrl: settings.baseUrl,
    email: settings.email,
    ...(includeToken && settings.apiToken
      ? { apiToken: settings.apiToken }
      : {}),
    hoursPerDay: settings.hoursPerDay,
    ...(settings.orgId ? { orgId: settings.orgId } : {}),
  };
}

/** Pure: the backup file's text for a state and this device's settings. */
export function buildBackup(
  state: AppState,
  device: { jira: JiraSettings; tagAliases: TagAlias[]; includeToken: boolean },
): string {
  const jira = jiraBackup(device.jira, device.includeToken);
  const backup: DeviceBackup = {
    version: DEVICE_BACKUP_VERSION,
    ...(jira ? { jira } : {}),
    ...(device.tagAliases.length > 0 ? { tagAliases: device.tagAliases } : {}),
  };
  const body = JSON.parse(serializeState(state)) as Record<string, unknown>;
  return JSON.stringify({ ...body, device: backup }, null, 2);
}

/** The backup file for what is on this device right now. */
export function buildDeviceBackup(
  state: AppState,
  includeToken: boolean,
): string {
  return buildBackup(state, {
    jira: readJiraSettings(),
    tagAliases: readTagAliases(),
    includeToken,
  });
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function coerceJira(value: unknown): JiraBackup | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const baseUrl = str(v.baseUrl).trim();
  const email = str(v.email).trim();
  if (!baseUrl && !email) return undefined;
  const hours = Number(v.hoursPerDay);
  const token = str(v.apiToken).trim();
  const orgId = str(v.orgId).trim();
  return {
    baseUrl,
    email,
    ...(token ? { apiToken: token } : {}),
    hoursPerDay:
      Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_HOURS_PER_DAY,
    ...(orgId ? { orgId } : {}),
  };
}

function coerceAliases(value: unknown): TagAlias[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: TagAlias[] = [];
  for (const row of value) {
    if (typeof row !== "object" || row === null) continue;
    const { tag, specialization } = row as Record<string, unknown>;
    if (typeof tag !== "string" || typeof specialization !== "string") continue;
    if (!tag.trim() || !specialization.trim()) continue;
    out.push({ tag: tag.trim(), specialization: specialization.trim() });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Split a backup (or any Planner export) into the state for the store and the
 * device settings for localStorage. The state never carries `device`.
 */
export function parseBackup(text: string): ParsedBackup {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("That file isn't valid JSON.");
  }
  let deviceRaw: unknown = undefined;
  let body = raw;
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const { device, ...rest } = raw as Record<string, unknown>;
    deviceRaw = device;
    body = rest;
  }
  const state = parseImportedState(JSON.stringify(body));

  let device: DeviceBackup | null = null;
  if (typeof deviceRaw === "object" && deviceRaw !== null) {
    const d = deviceRaw as Record<string, unknown>;
    const jira = coerceJira(d.jira);
    const tagAliases = coerceAliases(d.tagAliases);
    device = {
      version: typeof d.version === "number" ? d.version : 1,
      ...(jira ? { jira } : {}),
      ...(tagAliases ? { tagAliases } : {}),
    };
  }
  return { state, device };
}

/**
 * The Jira settings this device should hold after taking `incoming`.
 *
 * Writes stay as they are here (off unless this device turned them on). A
 * token missing from the file keeps this device's token only when it is for
 * the same site and account, since a token belongs to one account.
 */
export function mergedJiraSettings(
  current: JiraSettings,
  incoming: JiraBackup,
): JiraSettings {
  const sameAccount =
    current.baseUrl === incoming.baseUrl && current.email === incoming.email;
  return {
    baseUrl: incoming.baseUrl,
    email: incoming.email,
    apiToken: incoming.apiToken ?? (sameAccount ? current.apiToken : ""),
    hoursPerDay: incoming.hoursPerDay,
    allowWrites: current.allowWrites,
    ...(incoming.orgId
      ? { orgId: incoming.orgId }
      : sameAccount && current.orgId
        ? { orgId: current.orgId }
        : {}),
  };
}

/** Local mappings win; the file adds tags this device has never mapped. */
export function mergedTagAliases(
  current: TagAlias[],
  incoming: TagAlias[],
): TagAlias[] {
  const known = new Set(current.map((a) => a.tag.toLowerCase()));
  const added = incoming.filter((a) => !known.has(a.tag.toLowerCase()));
  return [...current, ...added];
}

export interface DeviceApplyResult {
  /** The Jira connection was replaced by the file's. */
  jira: boolean;
  /** The file had no token, so Jira still needs one typed in here. */
  jiraNeedsToken: boolean;
  addedTagAliases: number;
}

/** Write a backup's device settings into this device's localStorage. */
export function applyDeviceBackup(
  device: DeviceBackup,
  options: { replaceJira: boolean },
): DeviceApplyResult {
  let jira = false;
  let jiraNeedsToken = false;
  if (device.jira && options.replaceJira) {
    const next = mergedJiraSettings(readJiraSettings(), device.jira);
    writeJiraSettings(next);
    jira = true;
    jiraNeedsToken = !isJiraConfigured(next);
  }
  let addedTagAliases = 0;
  if (device.tagAliases) {
    const current = readTagAliases();
    const next = mergedTagAliases(current, device.tagAliases);
    addedTagAliases = next.length - current.length;
    if (addedTagAliases > 0) writeTagAliases(next);
  }
  return { jira, jiraNeedsToken, addedTagAliases };
}

/** A suggested filename for a full backup, with today's date. */
export function backupFilename(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `planner-backup-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.json`;
}
