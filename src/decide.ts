/**
 * The decision-engine seam.
 *
 * The gate itself (ordering, blocking, recording) is deterministic. Everything
 * probabilistic sits behind `DecisionEngine`, so the extension can be tested
 * without a network and so the JEV implementation can be swapped or disabled
 * without touching the safety-critical path.
 */

import type { GatedCall, RepoFacts } from "./call.ts";

export type DecisionSource = "hard-deny" | "user-rule" | "engine" | "unavailable" | "no-ui" | "user";

export interface EngineEvidence {
  /** Per-condition probability, when the engine exposes one. */
  readonly probabilities?: Readonly<Record<string, number>>;
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
 * Every candidate is reported as `uncertain`, which means "ask the user when a UI
 * exists, block otherwise". That keeps the deterministic layer shippable and
 * verifiable on its own, and it fails in the safe direction.
 */
export function createManualEngine(): DecisionEngine {
  return {
    id: "manual",
    judge: () => Promise.resolve({ verdict: "uncertain", rationale: "No semantic decision engine is configured." }),
  };
}
