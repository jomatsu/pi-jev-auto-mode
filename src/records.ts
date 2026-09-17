/**
 * Decision records.
 *
 * Records are written with `pi.appendEntry`, which keeps them out of the LLM
 * context on purpose: the model must not learn to argue with the gate, and a
 * recorded rationale should not become ammunition for the next tool call.
 */

import { Box, Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DecisionSource } from "./decide.ts";

export const DECISION_ENTRY_TYPE = "jev-auto-mode-decision";

export interface DecisionRecord {
  readonly tool: string;
  readonly summary: string;
  readonly reasons: readonly string[];
  readonly status: "allowed" | "blocked" | "confirmed" | "cancelled";
  readonly source: DecisionSource;
  readonly rationale: string;
  readonly probabilities?: Readonly<Record<string, number>>;
  readonly model?: string;
  readonly latencyMs?: number;
  readonly timestamp: number;
}

export type DecisionRecorder = (record: DecisionRecord) => void;

export function createRecorder(pi: Pick<ExtensionAPI, "appendEntry">): DecisionRecorder {
  return (record) => {
    try {
      pi.appendEntry(DECISION_ENTRY_TYPE, record);
    } catch (error) {
      console.warn("[jev-auto-mode] could not record a decision:", error);
    }
  };
}

const STATUS_LABEL: Record<DecisionRecord["status"], string> = {
  allowed: "allowed",
  blocked: "blocked",
  confirmed: "confirmed by user",
  cancelled: "cancelled by user",
};

export function formatDecisionLine(record: DecisionRecord): string {
  const parts = [`${record.tool}: ${STATUS_LABEL[record.status]}`, `via ${record.source}`];
  if (record.model) parts.push(record.model);
  if (typeof record.latencyMs === "number") parts.push(`${Math.round(record.latencyMs)}ms`);
  return parts.join(" · ");
}

export function formatProbabilities(probabilities: Readonly<Record<string, number>> | undefined): string[] {
  if (!probabilities) return [];
  return Object.entries(probabilities)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([ruleId, probability]) => `${ruleId}: ${probability.toFixed(3)}`);
}

export function registerDecisionEntryRenderer(pi: Pick<ExtensionAPI, "registerEntryRenderer">): void {
  pi.registerEntryRenderer<DecisionRecord>(DECISION_ENTRY_TYPE, (entry, options, theme) => {
    const record = entry.data;
    if (!record) return undefined;

    const approved = record.status === "allowed" || record.status === "confirmed";
    const icon = approved ? "🛡" : "⛔";
    const heading = `${icon} ${theme.bold("jev auto mode")} ${theme.fg(
      approved ? "success" : "error",
      STATUS_LABEL[record.status],
    )}`;

    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(heading));
    box.addChild(new Text(theme.fg("muted", formatDecisionLine(record))));
    box.addChild(new Text(record.summary));
    if (record.reasons.length > 0) {
      box.addChild(new Text(theme.fg("dim", `reasons: ${record.reasons.join(", ")}`)));
    }
    box.addChild(new Text(theme.fg("dim", `rationale: ${record.rationale}`)));

    if (options.expanded) {
      for (const line of formatProbabilities(record.probabilities)) {
        box.addChild(new Text(theme.fg("dim", line)));
      }
      box.addChild(new Text(theme.fg("dim", JSON.stringify(record, null, 2))));
    }

    return box;
  });
}
