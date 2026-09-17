/**
 * Recover what the user actually asked for.
 *
 * Only user-authored text is used. Assistant messages and tool output are
 * attacker-influenced in general (they contain file contents and command output),
 * so letting them shape "the user intent" would let repository content argue for
 * its own approval.
 */

export interface IntentOptions {
  /** How many of the most recent user messages to consider. */
  readonly maxMessages: number;
  readonly maxMessageChars: number;
  readonly maxTotalChars: number;
}

export const DEFAULT_INTENT_OPTIONS: IntentOptions = {
  // Wide enough that the request behind an ongoing task is still in the window. The
  // intent is a couple of percent of the request payload, so this costs little; losing
  // the request would make the gate look strict for the wrong reason.
  maxMessages: 12,
  maxMessageChars: 1200,
  maxTotalChars: 6000,
};

export const NO_INTENT_TEXT = "";

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

/** Flatten a Pi message content value into plain text. */
export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter((part): part is { type?: unknown; text?: unknown } => Boolean(part) && typeof part === "object")
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n")
    .trim();
}

/**
 * Recent user turns, oldest first.
 *
 * Messages carrying a `customType` are extension-injected context (plan mode and
 * similar), not user speech, so they are skipped.
 */
export function extractRecentIntent(
  branch: readonly unknown[],
  options: IntentOptions = DEFAULT_INTENT_OPTIONS,
): string {
  const collected: string[] = [];

  for (let index = branch.length - 1; index >= 0 && collected.length < options.maxMessages; index -= 1) {
    const entry = branch[index];
    if (!entry || typeof entry !== "object") continue;
    if ((entry as { type?: unknown }).type !== "message") continue;

    const message = (entry as { message?: { role?: unknown; content?: unknown; customType?: unknown } }).message;
    if (!message || message.role !== "user") continue;
    if (typeof message.customType === "string" && message.customType.length > 0) continue;

    const text = truncate(messageText(message.content), options.maxMessageChars);
    if (text) collected.push(text);
  }

  return truncate(collected.reverse().join("\n\n"), options.maxTotalChars);
}
