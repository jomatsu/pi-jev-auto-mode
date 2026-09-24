/**
 * Decision records.
 *
 * Records are written with `pi.appendEntry`, which keeps them out of the LLM
 * context on purpose: the model must not learn to argue with the gate, and a
 * recorded rationale should not become ammunition for the next tool call.
 */

import { Box, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ConditionReport, DecisionSource } from "./decide.ts";
import { formatThreshold } from "./jev/decide.ts";
import type { DisplayMode } from "./settings.ts";

export const DECISION_ENTRY_TYPE = "jev-auto-mode-decision";

export interface DecisionRecord {
  readonly tool: string;
  readonly summary: string;
  readonly reasons: readonly string[];
  readonly status: "allowed" | "blocked" | "confirmed" | "cancelled";
  readonly source: DecisionSource;
  readonly rationale: string;
  /** One entry per condition that was asked, in the order they were asked. */
  readonly conditions?: readonly ConditionReport[];
  readonly decidingRule?: string;
  readonly clearedByIntent?: readonly string[];
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
  if (record.decidingRule) parts.push(`decided by ${record.decidingRule}`);
  if (record.model) parts.push(record.model);
  if (typeof record.latencyMs === "number") parts.push(`${Math.round(record.latencyMs)}ms`);
  return parts.join(" · ");
}

const VERDICT_MARK: Record<ConditionReport["verdict"], string> = {
  satisfied: "pass",
  rejected: "reject",
  uncertain: "unclear",
  ignored: "ignored",
};

/**
 * One line per condition, with the band it landed in and the threshold it was
 * compared against. This is the view used to decide whether a threshold needs to
 * move, so it shows the passing values too.
 */
export function formatConditionLines(record: DecisionRecord): string[] {
  return (record.conditions ?? []).map((condition) => {
    const bounds =
      condition.verdict === "satisfied"
        ? `>= ${formatThreshold(condition.threshold)}`
        : condition.verdict === "rejected"
          ? `<= ${formatThreshold(1 - condition.threshold)}`
          : `${formatThreshold(1 - condition.threshold)}-${formatThreshold(condition.threshold)}`;
    const marks = [
      record.decidingRule === condition.ruleId ? "<- decided" : "",
      condition.clearedByIntent ? "(cleared by the user's request)" : "",
    ].filter(Boolean);
    return `${condition.ruleId}  p=${condition.probability.toFixed(2)}  ${VERDICT_MARK[condition.verdict]} (t=${formatThreshold(condition.threshold)}, ${bounds}) ${marks.join(" ")}`.trimEnd();
  });
}

/** Collapse whitespace so a multi-line command reads as one line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export interface CompactDecisionLines {
  /** `🛡 jev allowed · bash · 299ms · <command>`: everything an approval needs. */
  readonly headline: string;
  /**
   * The rationale, only for a call that did not run. An approval does not need its
   * reasoning on screen; a block does, because the user has to act on it.
   */
  readonly detail?: string;
}

/**
 * The compact view: one line for an approval, two for a block.
 *
 * Width is applied at render time. This only decides what the lines say.
 */
export function formatCompactLines(record: DecisionRecord): CompactDecisionLines {
  const approved = record.status === "allowed" || record.status === "confirmed";
  const parts = [`${approved ? "🛡" : "⛔"} jev ${STATUS_LABEL[record.status]}`, record.tool];
  if (!approved) parts.push(`via ${record.source}`);
  if (typeof record.latencyMs === "number") parts.push(`${Math.round(record.latencyMs)}ms`);
  const summary = oneLine(record.summary);
  if (summary.length > 0) parts.push(summary);
  const headline = parts.join(" · ");
  if (approved) return { headline };
  return { headline, detail: oneLine(record.rationale) };
}

/** A single line clipped to the viewport instead of wrapped. */
class ClippedLine implements Component {
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  render(width: number): string[] {
    return [truncateToWidth(this.text, Math.max(1, width))];
  }

  invalidate(): void {}
}

export type DisplayModeSource = () => DisplayMode;

export function registerDecisionEntryRenderer(
  pi: Pick<ExtensionAPI, "registerEntryRenderer">,
  displayMode: DisplayModeSource = () => "full",
): void {
  pi.registerEntryRenderer<DecisionRecord>(DECISION_ENTRY_TYPE, (entry, options, theme) => {
    const record = entry.data;
    if (!record) return undefined;

    const approved = record.status === "allowed" || record.status === "confirmed";

    // The expanded view is the place to read a decision in full, so it ignores the
    // compact setting.
    if (displayMode() === "compact" && !options.expanded) {
      const lines = formatCompactLines(record);
      const box = new Box(1, 0, (text) => theme.bg("customMessageBg", text));
      box.addChild(new ClippedLine(theme.fg(approved ? "muted" : "error", lines.headline)));
      if (lines.detail !== undefined) {
        box.addChild(new ClippedLine(theme.fg("dim", `rationale: ${lines.detail}`)));
      }
      return box;
    }

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
      for (const line of formatConditionLines(record)) {
        box.addChild(new Text(theme.fg("dim", line)));
      }
      box.addChild(new Text(theme.fg("dim", JSON.stringify(record, null, 2))));
    }

    return box;
  });
}
