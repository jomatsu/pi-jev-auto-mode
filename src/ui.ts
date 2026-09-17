/**
 * Footer status and user-facing text.
 *
 * The status line is the only always-visible signal that a probabilistic gate is
 * standing between the model and the shell, so it stays short but never silent:
 * "off" and "no decision engine" are different states and are shown differently.
 */

import type { JevAutoModeSettings, SettingsScope } from "./settings.ts";
import { DEFAULT_RULES, type JevRule } from "./jev/questions.ts";
import { formatThreshold, observe } from "./jev/decide.ts";

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
    `safe commands: ${settings.safeCommands.length}`,
    `allowed commands: ${settings.allowedCommands.length}`,
    `disallowed commands: ${settings.disallowedCommands.length}`,
    `extra protected paths: ${settings.extraProtectedPaths.length}`,
    `max state characters: ${settings.maxStateCharacters}`,
    `uncertain band: ${settings.uncertain}`,
  ].join("\n");
}

/**
 * A bounded rendering of a command, for dialogs.
 *
 * Pi's dialogs do not clip their content: a 60-line title fills the pane and pushes
 * the dialog's own heading off screen, and opening and closing one per tool call
 * makes the terminal scroll back and forth. So the preview is bounded here, and the
 * full command stays where it already is — in the tool call above the dialog.
 */
export interface CommandPreview {
  readonly lines: readonly string[];
  readonly truncated: boolean;
  readonly hiddenLines: number;
  readonly hiddenCharacters: number;
}

export const DEFAULT_PREVIEW_LINES = 6;
export const DEFAULT_PREVIEW_LINE_LENGTH = 120;

export function previewCommand(
  command: string,
  options: { readonly maxLines?: number; readonly maxLineLength?: number } = {},
): CommandPreview {
  const maxLines = options.maxLines ?? DEFAULT_PREVIEW_LINES;
  const maxLineLength = options.maxLineLength ?? DEFAULT_PREVIEW_LINE_LENGTH;

  const all = command.split("\n");
  const kept = all.slice(0, maxLines);
  const lines = kept.map((line) => (line.length > maxLineLength ? `${line.slice(0, maxLineLength)}…` : line));
  const hidden = all.slice(maxLines);

  // A single 4000-character line has no hidden lines, but most of it was still cut.
  const cutCharacters = kept.reduce((total, line, index) => total + Math.max(0, line.length - (lines[index]?.length ?? 0)), 0);
  const hiddenCharacters = hidden.reduce((total, line) => total + line.length + 1, 0) + cutCharacters;

  return {
    lines,
    truncated: hidden.length > 0 || cutCharacters > 0,
    hiddenLines: hidden.length,
    hiddenCharacters,
  };
}

/** Cut a text block to a line budget, marking what was dropped. */
export function clampLines(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return [...lines.slice(0, maxLines - 1), `… (${lines.length - maxLines + 1} more lines)`].join("\n");
}

export interface ConfirmationParts {
  readonly tool: string;
  readonly command?: string;
  readonly path?: string;
  readonly reasons: readonly string[];
  readonly rationale: string;
}

/** The dialog shown when a judgment is delegated to the user. */
export const CONFIRMATION_MAX_LINES = 14;

export function buildConfirmationDialog(parts: ConfirmationParts): string {
  const preview = parts.command === undefined ? undefined : previewCommand(parts.command);
  const hiddenNote =
    preview?.truncated === true
      ? `… ${[
          preview.hiddenLines > 0 ? `${preview.hiddenLines} more line(s)` : undefined,
          `${preview.hiddenCharacters} more character(s)`,
        ]
          .filter(Boolean)
          .join(", ")} — the full command is in the tool call above`
      : undefined;

  return clampLines(
    [
      "Jev auto mode wants confirmation before this runs.",
      `Tool: ${parts.tool}`,
      ...(preview?.lines ?? []),
      ...(hiddenNote === undefined ? [] : [hiddenNote]),
      ...(parts.path === undefined ? [] : [parts.path]),
      "",
      `Matched: ${parts.reasons.join(", ")}`,
      parts.rationale,
    ].join("\n"),
    CONFIRMATION_MAX_LINES,
  );
}

export const USAGE_TEXT = [
  "Usage:",
  "  /jev-auto-mode                     show status",
  "  /jev-auto-mode on|off              toggle auto mode",
  "  /jev-auto-mode login|logout        store or remove the TypeSafe API key",
  "  /jev-auto-mode policy              list the user policy notes",
  "  /jev-auto-mode policy edit",
  "  /jev-auto-mode policy clear",
  "  /jev-auto-mode threshold           show thresholds and last observed probabilities",
  "  /jev-auto-mode threshold <rule> <0.5-1.0>",
  "  /jev-auto-mode threshold reset [rule]",
  "  /jev-auto-mode threshold edit      pick a rule and type a value",
  "  /jev-auto-mode uncertain            show what the middle band resolves to",
  "  /jev-auto-mode uncertain deny|ask|allow",
].join("\n");

export const UNCERTAIN_EXPLANATION = [
  "The middle band is where Jev is neither satisfied nor rejecting.",
  "  deny  - block it. No prompt, no screen takeover: Jev's probability is the answer.",
  "  ask   - hand the call to the user. Opt-in, because it hands the decision back to a human.",
  "  allow - let it through. Trusts the band; the least safe of the three.",
].join("\n");

export const POLICY_HEADER = [
  "# Jev auto mode policy",
  "",
  "Free-form notes describing what this machine and these repositories allow.",
  "They are reference material for the semantic judgment: they can justify an",
  "approval, but they cannot override hard-deny rules.",
].join("\n");

/**
 * The most recent judgment of one condition, kept for threshold tuning.
 *
 * Only the probability is stored. The band is recomputed against the *current*
 * threshold, so changing a threshold immediately shows what the last judgment would
 * have become — storing the band would leave a stale label next to a threshold that
 * no longer produced it.
 */
export interface ObservedCondition {
  readonly probability: number;
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
 * actually answered for calls you care about. The band is recomputed against the
 * current threshold, so the table doubles as a what-if view while tuning.
 */
export function formatRuleTable(
  rules: readonly JevRule[] = DEFAULT_RULES,
  overrides: Readonly<Record<string, number>> = {},
  observed: ReadonlyMap<string, ObservedCondition> = new Map(),
): string {
  const header = `${pad("rule", 28)}${pad("mode", 10)}${pad("severity", 10)}${pad("threshold", 30)}last observed`;
  const rows = rules.map((rule) => {
    const override = overrides[rule.id];
    const threshold = override ?? rule.threshold;
    const origin = override === undefined ? "default" : `override (default ${formatThreshold(rule.threshold)})`;
    // Recompute against the effective rule, not the default one: the point of the
    // last-observed column is to answer "what would this answer mean now".
    const effective = override === undefined ? rule : { ...rule, threshold: override };
    return `${pad(rule.id, 28)}${pad(rule.mode, 10)}${pad(rule.severity, 10)}${pad(`${formatThreshold(threshold)} ${origin}`, 30)}${describeLast(effective, observed.get(rule.id))}`;
  });

  const unknown = Object.keys(overrides).filter((ruleId) => !rules.some((rule) => rule.id === ruleId));
  if (unknown.length > 0) {
    rows.push(`\noverride(s) that match no known rule: ${unknown.join(", ")}`);
  }

  return [header, ...rows].join("\n");
}

function describeLast(rule: JevRule, last: ObservedCondition | undefined): string {
  if (!last) return "-";
  const [observation] = observe([rule], { [rule.id]: last.probability });
  const band = observation?.verdict ?? "uncertain";
  const label = band === "uncertain" && observation?.effective === "satisfied" ? "ignored" : band;
  return `p=${last.probability.toFixed(2)} (${label})`;
}
