/**
 * The JEV decision engine.
 *
 * One tool call in, one request out. All conditions for the call travel in the
 * same request because JEV answers them in parallel and independently, so the
 * marginal cost of an extra condition is a few tokens rather than a round trip.
 *
 * Everything that can go wrong resolves to `unavailable`, and the caller turns
 * that into a block. The engine never invents an approval.
 */

import { toJevState, NO_POLICY_PLACEHOLDER } from "../call.ts";
import type { CandidateInput, ConditionReport, DecisionEngine, EngineVerdict, JudgeOptions } from "../decide.ts";
import { combine, observe, type Observation } from "./decide.ts";
import { DEFAULT_RULES, applyThresholdOverrides, buildQuestions, rulesForTool, type JevRule } from "./questions.ts";
import { parseAnswers } from "./response.ts";
import type { JevTransport } from "./types.ts";

export interface ObservationMeta {
  readonly model: string;
  readonly latencyMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface JevEngineOptions {
  readonly transport: JevTransport;
  readonly rules?: readonly JevRule[];
  readonly model?: string;
  /** Per-rule threshold overrides from settings. */
  readonly thresholds?: Readonly<Record<string, number>>;
  /** Shared state + questions budget, in characters. */
  readonly maxStateCharacters?: number;
  readonly now?: () => number;
  /**
   * Called for every condition of every judgment, including the ones that
   * passed. This is the calibration channel: without the passing probabilities
   * there is no way to choose a threshold that is not a guess.
   */
  readonly onObservation?: (observations: readonly Observation[], meta: ObservationMeta) => void;
}

export const DEFAULT_MAX_STATE_CHARACTERS = 120_000;

const UNAVAILABLE_TEXT: Record<string, string> = {
  timeout: "the JEV request timed out",
  network: "the JEV request could not reach the API",
  http: "the JEV API returned an error status",
  malformed_response: "the JEV response did not match the questions that were asked",
  state_too_large: "the call description exceeded the request budget",
  unknown: "the JEV request failed for an unknown reason",
};

export function createJevEngine(options: JevEngineOptions): DecisionEngine {
  const rules = options.rules ?? DEFAULT_RULES;
  const maxStateCharacters = options.maxStateCharacters ?? DEFAULT_MAX_STATE_CHARACTERS;
  const now = options.now ?? (() => Date.now());

  return {
    id: "jev",

    async judge(input: CandidateInput, judgeOptions: JudgeOptions): Promise<EngineVerdict> {
      // The policy condition is skipped when no policy is configured: asking
      // "does this violate the policy" with an empty policy produced 0.66-0.85 on
      // every fixture, which would have escalated every call.
      const hasPolicy = input.policy.trim().length > 0 && input.policy !== NO_POLICY_PLACEHOLDER;
      const applicable = applyThresholdOverrides(
        rulesForTool(input.call.tool, rules, {
          hasPolicy,
          hasProtectedTarget: input.call.protectedReason !== undefined,
        }),
        options.thresholds,
      );
      const state = toJevState(input);
      const questions = buildQuestions(applicable);

      // The API budget is shared between state and questions, and a request that
      // is too large is rejected before it is sent: cheaper, and it keeps a huge
      // diff or command from being truncated on the remote side.
      const characters = JSON.stringify(state).length + JSON.stringify(questions).length;
      if (characters > maxStateCharacters) {
        return {
          verdict: "unavailable",
          reason: "state_too_large",
          rationale: `The call description was ${characters} characters, over the ${maxStateCharacters} character budget.`,
        };
      }

      const startedAt = now();
      const result = await options.transport.systemOne({
        state,
        questions,
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(judgeOptions.signal === undefined ? {} : { signal: judgeOptions.signal }),
      });
      const latencyMs = now() - startedAt;

      if (!result.ok) {
        return {
          verdict: "unavailable",
          reason: result.reason,
          rationale: UNAVAILABLE_TEXT[result.reason] ?? UNAVAILABLE_TEXT.unknown ?? "JEV could not decide.",
          latencyMs,
        };
      }

      const parsed = parseAnswers(result.response, Object.keys(questions));
      if (!parsed.ok) {
        return {
          verdict: "unavailable",
          reason: parsed.reason,
          rationale: UNAVAILABLE_TEXT[parsed.reason] ?? "The JEV response could not be used.",
          latencyMs,
        };
      }

      const observations = observe(applicable, parsed.parsed.answers);
      options.onObservation?.(observations, {
        model: parsed.parsed.model,
        latencyMs,
        inputTokens: parsed.parsed.inputTokens,
        outputTokens: parsed.parsed.outputTokens,
      });

      const combined = combine(applicable, observations);
      const thresholds: Record<string, number> = {};
      for (const rule of applicable) thresholds[rule.id] = rule.threshold;

      const cleared = new Set(combined.clearedByIntent);
      const conditions: ConditionReport[] = applicable.map((rule, index) => {
        const observation = observations[index];
        const verdict = observation?.verdict ?? "uncertain";
        return {
          ruleId: rule.id,
          label: rule.label,
          probability: observation?.probability ?? 0,
          threshold: rule.threshold,
          verdict: verdict === "uncertain" && rule.mode === "hazard" ? "ignored" : verdict,
          clearedByIntent: cleared.has(rule.id),
        };
      });

      const evidence = {
        probabilities: combined.probabilities,
        thresholds,
        conditions,
        model: parsed.parsed.model,
        latencyMs,
        ...(combined.decidingRule === undefined ? {} : { decidingRule: combined.decidingRule }),
        ...(combined.clearedByIntent.length === 0 ? {} : { clearedByIntent: combined.clearedByIntent }),
      };

      switch (combined.verdict) {
        case "allow":
          return { verdict: "allow", rationale: combined.rationale, ...evidence };
        case "deny":
          return { verdict: "deny", rationale: combined.rationale, ...evidence };
        case "uncertain":
          return { verdict: "uncertain", rationale: combined.rationale, ...evidence };
      }
    },
  };
}
