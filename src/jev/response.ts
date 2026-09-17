/**
 * Turn an SDK response into trustable numbers.
 *
 * The API can answer 200 with a body that does not match the request: a missing
 * question key, a string where a probability belongs, a number outside [0, 1].
 * None of those may be treated as an approval, so the shape is checked here
 * rather than assumed from the HTTP status.
 */

import type { JevUnavailableReason } from "./types.ts";

export interface ParsedAnswers {
  readonly model: string;
  readonly answers: Readonly<Record<string, number>>;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export type ParseResult =
  | { readonly ok: true; readonly parsed: ParsedAnswers }
  | { readonly ok: false; readonly reason: JevUnavailableReason };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

/**
 * Validate a response against the question keys that were actually asked.
 *
 * A key that was asked and not answered is a failure, not a default: the whole
 * point of a gate is that "no answer" and "yes" are different.
 */
export function parseAnswers(response: unknown, questionKeys: readonly string[]): ParseResult {
  if (!isRecord(response)) return { ok: false, reason: "malformed_response" };
  if (!isRecord(response.answers)) return { ok: false, reason: "malformed_response" };

  const answers: Record<string, number> = {};
  for (const key of questionKeys) {
    const answer = response.answers[key];
    if (!isRecord(answer)) return { ok: false, reason: "malformed_response" };
    const probability = answer.noul;
    if (typeof probability !== "number" || !Number.isFinite(probability)) {
      return { ok: false, reason: "malformed_response" };
    }
    if (probability < 0 || probability > 1) return { ok: false, reason: "malformed_response" };
    answers[key] = probability;
  }

  const usage = isRecord(response.usage) ? response.usage : {};

  return {
    ok: true,
    parsed: {
      model: typeof response.model === "string" && response.model.length > 0 ? response.model : "unknown",
      answers,
      inputTokens: readTokenCount(usage.input_tokens),
      outputTokens: readTokenCount(usage.output_tokens),
    },
  };
}
