/**
 * Settings and user policy notes.
 *
 * Global settings live next to the rest of the Pi agent state
 * (`$PI_CODING_AGENT_DIR` or `~/.pi/agent`). A project can override them from
 * `<cwd>/<CONFIG_DIR_NAME>/jev-auto-mode.json`, but only for a trusted project:
 * an untrusted checkout must not be able to loosen the gate that is judging it.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface JevAutoModeSettings {
  readonly enabled: boolean;
  /** Per-attempt JEV timeout. Kept short: this is a gate, not a batch job. */
  readonly timeoutMs: number;
  /** Retries after the first attempt. */
  readonly maxRetries: number;
  readonly allowedCommands: readonly string[];
  readonly disallowedCommands: readonly string[];
  readonly extraProtectedPaths: readonly string[];
  /** Shared state + questions budget guard, in characters. */
  readonly maxStateCharacters: number;
  /**
   * Per-rule probability thresholds, overriding the calibrated defaults.
   *
   * Keys are rule ids. An unknown key is kept but has no effect, so a typo is
   * visible in `/jev-auto-mode threshold` instead of silently resetting the rule.
   */
  readonly thresholds: Readonly<Record<string, number>>;
}

export type SettingsScope = "global" | "project";

export const DEFAULT_SETTINGS: JevAutoModeSettings = {
  enabled: true,
  timeoutMs: 4000,
  maxRetries: 1,
  // User additions only. The built-in safe commands live in `policy.ts` and are
  // not configurable, so a settings file cannot quietly widen the fast path.
  allowedCommands: [],
  disallowedCommands: [],
  extraProtectedPaths: [],
  maxStateCharacters: 120_000,
  thresholds: {},
};

const MAX_PATTERN_ENTRIES = 200;
const MAX_PATTERN_LENGTH = 300;
const MAX_THRESHOLD_ENTRIES = 32;
const MAX_RULE_ID_LENGTH = 64;
const MAX_POLICY_NOTES_LENGTH = 8000;
const MIN_TIMEOUT_MS = 250;
const MAX_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 5;

/** A probability threshold must leave a middle band on both sides. */
export const MIN_THRESHOLD = 0.5;
export const MAX_THRESHOLD = 1;

export interface StoreOptions {
  /** Usually `~/.pi/agent`, honoring `PI_CODING_AGENT_DIR`. */
  readonly agentDir: string;
  /** Usually `.pi` (`CONFIG_DIR_NAME`). */
  readonly configDirName: string;
}

export type SettingsPatch = { -readonly [K in keyof JevAutoModeSettings]?: JevAutoModeSettings[K] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate a single threshold value. Returns `undefined` when it is not usable. */
export function parseThreshold(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value <= MIN_THRESHOLD || value > MAX_THRESHOLD) return undefined;
  return value;
}

function readThresholds(value: unknown): Readonly<Record<string, number>> | undefined {
  if (!isRecord(value)) return undefined;
  const thresholds: Record<string, number> = {};
  for (const [ruleId, raw] of Object.entries(value)) {
    if (ruleId.length === 0 || ruleId.length > MAX_RULE_ID_LENGTH) continue;
    const threshold = parseThreshold(raw);
    if (threshold === undefined) continue;
    thresholds[ruleId] = threshold;
    if (Object.keys(thresholds).length >= MAX_THRESHOLD_ENTRIES) break;
  }
  return thresholds;
}

function readBoundedInteger(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(value);
  if (rounded < min || rounded > max) return undefined;
  return rounded;
}

function readStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && entry.length <= MAX_PATTERN_LENGTH && !entry.includes("\n"))
    .slice(0, MAX_PATTERN_ENTRIES);
}

/**
 * Validate an untrusted settings file.
 *
 * Malformed values are dropped rather than replaced by a default: a broken
 * project file must not be able to pin a value that overrides the global layer.
 * Unknown fields are ignored too.
 */
export function parseSettingsPatch(value: unknown): SettingsPatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const patch: SettingsPatch = {};

  if (typeof record.enabled === "boolean") patch.enabled = record.enabled;

  const timeoutMs = readBoundedInteger(record.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
  if (timeoutMs !== undefined) patch.timeoutMs = timeoutMs;

  const maxRetries = readBoundedInteger(record.maxRetries, 0, MAX_RETRIES);
  if (maxRetries !== undefined) patch.maxRetries = maxRetries;

  const maxStateCharacters = readBoundedInteger(record.maxStateCharacters, 1000, 1_000_000);
  if (maxStateCharacters !== undefined) patch.maxStateCharacters = maxStateCharacters;

  const allowedCommands = record.allowedCommands === undefined ? undefined : readStringArray(record.allowedCommands);
  if (allowedCommands !== undefined) patch.allowedCommands = allowedCommands;

  const disallowedCommands =
    record.disallowedCommands === undefined ? undefined : readStringArray(record.disallowedCommands);
  if (disallowedCommands !== undefined) patch.disallowedCommands = disallowedCommands;

  const extraProtectedPaths =
    record.extraProtectedPaths === undefined ? undefined : readStringArray(record.extraProtectedPaths);
  if (extraProtectedPaths !== undefined) patch.extraProtectedPaths = extraProtectedPaths;

  const thresholds = record.thresholds === undefined ? undefined : readThresholds(record.thresholds);
  if (thresholds !== undefined) patch.thresholds = thresholds;

  return patch;
}

export function mergeSettings(base: JevAutoModeSettings, patch: SettingsPatch): JevAutoModeSettings {
  const merged = { ...base, ...patch };
  // Thresholds merge per rule: a project file that retunes one condition must not
  // wipe the global overrides for the others.
  if (patch.thresholds !== undefined) {
    merged.thresholds = { ...base.thresholds, ...patch.thresholds };
  }
  return merged;
}

async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

async function writeFileAtomic(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, contents, "utf8");
  await rename(temporary, path);
}

export class JevAutoModeStore {
  private readonly agentDir: string;
  private readonly configDirName: string;

  constructor(options: StoreOptions) {
    this.agentDir = options.agentDir;
    this.configDirName = options.configDirName;
  }

  globalSettingsPath(): string {
    return join(this.agentDir, "jev-auto-mode.json");
  }

  projectSettingsPath(cwd: string): string {
    return join(cwd, this.configDirName, "jev-auto-mode.json");
  }

  policyNotesPath(): string {
    return join(this.agentDir, "jev-auto-mode-policy.md");
  }

  /** Global settings with the project override layered on top, when trusted. */
  async loadSettings(cwd: string, projectTrusted: boolean): Promise<{ settings: JevAutoModeSettings; scope: SettingsScope }> {
    const globalPatch = parseSettingsPatch(await readJsonFile(this.globalSettingsPath()));
    if (!projectTrusted) {
      return { settings: mergeSettings(DEFAULT_SETTINGS, globalPatch), scope: "global" };
    }
    const projectValue = await readJsonFile(this.projectSettingsPath(cwd));
    const hasProjectSettings = projectValue !== undefined;
    const projectPatch = parseSettingsPatch(projectValue);
    return {
      settings: mergeSettings(mergeSettings(DEFAULT_SETTINGS, globalPatch), projectPatch),
      scope: hasProjectSettings ? "project" : "global",
    };
  }

  async saveSettings(settings: JevAutoModeSettings, scope: SettingsScope, cwd: string): Promise<void> {
    const path = scope === "project" ? this.projectSettingsPath(cwd) : this.globalSettingsPath();
    await writeFileAtomic(path, `${JSON.stringify(settings, null, 2)}\n`);
  }

  /** User-authored policy notes. Advisory input to JEV, never a hard rule. */
  async loadPolicyNotes(): Promise<string> {
    try {
      return (await readFile(this.policyNotesPath(), "utf8")).slice(0, MAX_POLICY_NOTES_LENGTH);
    } catch {
      return "";
    }
  }

  async savePolicyNotes(notes: string): Promise<void> {
    await writeFileAtomic(this.policyNotesPath(), notes.slice(0, MAX_POLICY_NOTES_LENGTH));
  }
}
