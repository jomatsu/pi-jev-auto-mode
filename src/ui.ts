/**
 * Footer status and user-facing text.
 *
 * The status line is the only always-visible signal that a probabilistic gate is
 * standing between the model and the shell, so it stays short but never silent:
 * "off" and "no decision engine" are different states and are shown differently.
 */

import type { JevAutoModeSettings, SettingsScope } from "./settings.ts";
import { DEFAULT_RULES, type JevRule } from "./jev/questions.ts";

export const STATUS_ID = "jev-auto-mode";

export interface StatusInput {
  readonly enabled: boolean;
  readonly engineId: string;
  readonly scope: SettingsScope;
}

export function statusText(input: StatusInput): string {
  if (!input.enabled) return "🛡 jev off";
  const scope = input.scope === "project" ? "project" : "global";
  const engine = input.engineId === "manual" ? " ask-only" : "";
  return `🛡 jev${engine} (${scope})`;
}

export interface StatusContext {
  readonly ui: { setStatus(key: string, value: string | undefined): void };
}

export function updateStatus(ctx: StatusContext, input: StatusInput): void {
  ctx.ui.setStatus(STATUS_ID, statusText(input));
}

export function describeSettings(settings: JevAutoModeSettings, scope: SettingsScope): string {
  return [
    `enabled: ${settings.enabled}`,
    `scope: ${scope}`,
    `timeout: ${settings.timeoutMs}ms (retries ${settings.maxRetries})`,
    `allowed commands: ${settings.allowedCommands.length}`,
    `disallowed commands: ${settings.disallowedCommands.length}`,
    `extra protected paths: ${settings.extraProtectedPaths.length}`,
    `max state characters: ${settings.maxStateCharacters}`,
  ].join("\n");
}

export const USAGE_TEXT = [
  "Usage:",
  "  /jev-auto-mode                     show status",
  "  /jev-auto-mode on|off              toggle auto mode",
  "  /jev-auto-mode policy              list the user policy notes",
  "  /jev-auto-mode policy edit",
  "  /jev-auto-mode policy clear",
  "  /jev-auto-mode threshold           show thresholds and last observed probabilities",
  "  /jev-auto-mode threshold <rule> <0.5-1.0>",
  "  /jev-auto-mode threshold reset [rule]",
].join("\n");

export const POLICY_HEADER = [
  "# JEV auto mode policy",
  "",
  "Free-form notes describing what this machine and these repositories allow.",
  "They are reference material for the semantic judgment: they can justify an",
  "approval, but they cannot override hard-deny rules.",
].join("\n");

/** The most recent judgment of one condition, kept for threshold tuning. */
export interface ObservedCondition {
  readonly probability: number;
  readonly threshold: number;
  readonly verdict: string;
  readonly at: number;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

/**
 * The tuning table.
 *
 * Showing the last observed probability next to each threshold is the whole point:
 * a threshold cannot be chosen from a rule description, only from what the model
 * actually answered for calls you care about.
 */
export function formatRuleTable(
  rules: readonly JevRule[] = DEFAULT_RULES,
  overrides: Readonly<Record<string, number>> = {},
  observed: ReadonlyMap<string, ObservedCondition> = new Map(),
): string {
  const header = `${pad("rule", 24)}${pad("mode", 10)}${pad("severity", 10)}${pad("threshold", 30)}last observed`;
  const rows = rules.map((rule) => {
    const override = overrides[rule.id];
    const threshold = override ?? rule.threshold;
    const origin = override === undefined ? "default" : `override (default ${rule.threshold.toFixed(2)})`;
    const last = observed.get(rule.id);
    const lastText = last
      ? `p=${last.probability.toFixed(2)} (${last.verdict})`
      : "-";
    return `${pad(rule.id, 24)}${pad(rule.mode, 10)}${pad(rule.severity, 10)}${pad(`${threshold.toFixed(2)} ${origin}`, 30)}${lastText}`;
  });

  const unknown = Object.keys(overrides).filter((ruleId) => !rules.some((rule) => rule.id === ruleId));
  if (unknown.length > 0) {
    rows.push(`\noverride(s) that match no known rule: ${unknown.join(", ")}`);
  }

  return [header, ...rows].join("\n");
}
