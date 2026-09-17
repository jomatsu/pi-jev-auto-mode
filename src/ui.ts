/**
 * Footer status and user-facing text.
 *
 * The status line is the only always-visible signal that a probabilistic gate is
 * standing between the model and the shell, so it stays short but never silent:
 * "off" and "no decision engine" are different states and are shown differently.
 */

import type { JevAutoModeSettings, SettingsScope } from "./settings.ts";

export const STATUS_ID = "jev-auto-mode";

export interface StatusInput {
  readonly enabled: boolean;
  readonly engineId: string;
  readonly scope: SettingsScope;
}

export function statusText(input: StatusInput): string {
  if (!input.enabled) return "🛡 jev off";
  const engine = input.engineId === "manual" ? "ask-only" : input.engineId;
  const scope = input.scope === "project" ? "project" : "global";
  return `🛡 jev ${engine} (${scope})`;
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
  "  /jev-auto-mode            show status",
  "  /jev-auto-mode on|off     toggle auto mode",
  "  /jev-auto-mode policy     list the user policy notes",
  "  /jev-auto-mode policy edit",
  "  /jev-auto-mode policy clear",
].join("\n");

export const POLICY_HEADER = [
  "# JEV auto mode policy",
  "",
  "Free-form notes describing what this machine and these repositories allow.",
  "They are reference material for the semantic judgment: they can justify an",
  "approval, but they cannot override hard-deny rules.",
].join("\n");
