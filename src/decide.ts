/**
 * The decision-engine seam.
 *
 * The gate itself (ordering, blocking, recording) is deterministic. Everything
 * probabilistic sits behind `DecisionEngine`, so the extension can be tested
 * without a network and so the Jev implementation can be swapped or disabled
 * without touching the safety-critical path.
 */

import type { GatedCall, RepoFacts } from "./call.ts";

export type DecisionSource = "hard-deny" | "user-rule" | "engine" | "uncertain" | "unavailable" | "no-ui" | "user";

/**
 * A display-ready report of one condition's judgment.
 *
 * `verdict` is the band the probability fell into; `ignored` means a hazard-mode
 * condition landed in the middle band, which is not evidence of anything. This is
 * what a record shows during threshold tuning.
 */
export interface ConditionReport {
  readonly ruleId: string;
  readonly label: string;
  readonly probability: number;
  readonly threshold: number;
  readonly verdict: "satisfied" | "rejected" | "uncertain" | "ignored";
  readonly clearedByIntent: boolean;
}

export interface EngineEvidence {
  /** Per-condition probability, when the engine exposes one. */
  readonly probabilities?: Readonly<Record<string, number>>;
  /** The threshold each probability was compared against. */
  readonly thresholds?: Readonly<Record<string, number>>;
  /** One entry per condition that was asked. */
  readonly conditions?: readonly ConditionReport[];
  /** The condition that decided the call, when one did. */
  readonly decidingRule?: string;
  /** Conditions whose clear rejection the user's own request cleared. */
  readonly clearedByIntent?: readonly string[];
  readonly model?: string;
  readonly latencyMs?: number;
}

export type EngineVerdict =
  | ({ readonly verdict: "allow"; readonly rationale: string } & EngineEvidence)
  | ({ readonly verdict: "deny"; readonly rationale: string } & EngineEvidence)
  | ({ readonly verdict: "uncertain"; readonly rationale: string } & EngineEvidence)
  | ({ readonly verdict: "unavailable"; readonly rationale: string; readonly reason: string } & EngineEvidence);

export interface CandidateInput {
  readonly call: GatedCall;
  /** Names of the policy patterns this call matched. */
  readonly reasons: readonly string[];
  /**
   * Whether the deterministic layer recognised the call as a dangerous shape.
   * Required rather than optional: a caller that forgets it would silently skip the
   * intent question, which is the wrong direction to fail in.
   */
  readonly flagged: boolean;
  readonly intent: string;
  readonly policy: string;
  readonly repo: RepoFacts;
}

export interface JudgeOptions {
  readonly signal?: AbortSignal;
}

export interface DecisionEngine {
  readonly id: string;
  judge(input: CandidateInput, options: JudgeOptions): Promise<EngineVerdict>;
}

/**
 * Milestone-1 engine: no semantic judgment at all.
 *
 * The gate checks for this engine before judging: with no key there is nothing to
 * judge with, so it says so and blocks the call instead of inventing a verdict.
 */
export function createManualEngine(): DecisionEngine {
  return {
    id: "manual",
    judge: () => Promise.resolve({ verdict: "uncertain", rationale: "No semantic decision engine is configured." }),
  };
}
