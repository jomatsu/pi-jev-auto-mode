/**
 * Probability to decision.
 *
 * Two symmetric thresholds per condition:
 *
 *   p >= t          → satisfied
 *   p <= 1 - t      → rejected ("the opposite is as certain as a pass would be")
 *   in between      → the middle band
 *
 * The middle band is not a bug to be squeezed out. Measured JEV answers sit at
 * 0.98/0.02 for clear cases but also at 0.85–0.95 for conditions that are clear
 * to a human and merely not certain to the model, so a single high bar would
 * report almost everything as uncertain. What the middle band *means* depends on
 * the rule:
 *
 *   required → the middle band is escalated (ask the user)
 *   hazard   → the middle band is ignored, because "no hazard is evident" is not
 *              the same as "a hazard is present"
 *
 * Composition is done here, in code, so the model never has to weigh concerns
 * against each other. A single un-cleared hazard decides the call.
 */

import type { JevRule } from "./questions.ts";

export type ConditionVerdict = "satisfied" | "rejected" | "uncertain";

/**
 * Tolerance for the two boundaries.
 *
 * `1 - 0.9` is `0.09999999999999998` in IEEE 754, so an exact comparison would put
 * `p = 0.1, t = 0.9` in the middle band even though the rule says a rejection.
 * The widened side is the reject side, which is the direction a gate should err in.
 */
const BOUNDARY_EPSILON = 1e-9;

export interface Observation {
  readonly ruleId: string;
  readonly probability: number;
  readonly threshold: number;
  readonly verdict: ConditionVerdict;
}

export function classifyCondition(probability: number, threshold: number): ConditionVerdict {
  if (probability >= threshold - BOUNDARY_EPSILON) return "satisfied";
  if (probability <= 1 - threshold + BOUNDARY_EPSILON) return "rejected";
  return "uncertain";
}

export function observe(rules: readonly JevRule[], answers: Readonly<Record<string, number>>): Observation[] {
  return rules.map((rule) => {
    // A missing answer must not become an approval. The engine rejects a response
    // with missing keys before reaching here; defaulting to 0 means "rejected".
    const probability = answers[rule.id] ?? 0;
    const classified = classifyCondition(probability, rule.threshold);
    const verdict = rule.mode === "hazard" && classified === "uncertain" ? "satisfied" : classified;
    return { ruleId: rule.id, probability, threshold: rule.threshold, verdict };
  });
}

export interface CombinedDecision {
  readonly verdict: "allow" | "deny" | "uncertain";
  readonly rationale: string;
  readonly probabilities: Readonly<Record<string, number>>;
  /** Rules whose clear rejection was cleared by the user's own request. */
  readonly clearedByIntent: readonly string[];
}

const INTENT_RULE_ID = "intent_coverage";

function formatProbability(value: number): string {
  return value.toFixed(2);
}

function describe(rules: readonly JevRule[], observation: Observation): string {
  const rule = rules.find((candidate) => candidate.id === observation.ruleId);
  return `${rule?.label ?? observation.ruleId} (p=${formatProbability(observation.probability)})`;
}

/**
 * Combine conditions:
 *
 * 1. A rejected `hazard`-severity rule blocks, whatever the user asked for.
 * 2. A rejected `soft` rule is cleared when the intent condition is satisfied —
 *    the user's own words are the authority for actions they are entitled to
 *    request, and the deterministic layer already holds the non-negotiable line.
 * 3. An unclear `required` condition escalates to a confirmation.
 * 4. Otherwise the call is approved.
 */
export function combine(rules: readonly JevRule[], observations: readonly Observation[]): CombinedDecision {
  const probabilities: Record<string, number> = {};
  for (const observation of observations) probabilities[observation.ruleId] = observation.probability;

  const severityOf = (observation: Observation): JevRule["severity"] =>
    rules.find((rule) => rule.id === observation.ruleId)?.severity ?? "hazard";

  const rejected = observations.filter((observation) => observation.verdict === "rejected");
  const blocking = rejected.filter((observation) => severityOf(observation) === "hazard");
  if (blocking.length > 0) {
    const first = blocking[0] as Observation;
    const rule = rules.find((candidate) => candidate.id === first.ruleId);
    return {
      verdict: "deny",
      rationale: `${rule?.denyMessage ?? "A safety condition was clearly violated."} ${describe(rules, first)}`,
      probabilities,
      clearedByIntent: [],
    };
  }

  const intentSatisfied = observations.some(
    (observation) => observation.ruleId === INTENT_RULE_ID && observation.verdict === "satisfied",
  );

  const soft = rejected.filter((observation) => severityOf(observation) === "soft");
  if (soft.length > 0) {
    const first = soft[0] as Observation;
    const rule = rules.find((candidate) => candidate.id === first.ruleId);
    if (!intentSatisfied) {
      return {
        verdict: "deny",
        rationale: `${rule?.denyMessage ?? "A safety condition was clearly violated."} ${describe(rules, first)}`,
        probabilities,
        clearedByIntent: [],
      };
    }
    return {
      verdict: "allow",
      rationale: `The user's request covers this call, clearing ${describe(rules, first)}.`,
      probabilities,
      clearedByIntent: soft.map((observation) => observation.ruleId),
    };
  }

  const uncertain = observations.filter((observation) => observation.verdict === "uncertain");
  const firstUncertain = uncertain[0];
  if (firstUncertain) {
    const rule = rules.find((candidate) => candidate.id === firstUncertain.ruleId);
    return {
      verdict: "uncertain",
      rationale: `${rule?.uncertainMessage ?? "A safety condition could not be decided."} ${describe(rules, firstUncertain)}`,
      probabilities,
      clearedByIntent: [],
    };
  }

  const lowest = observations.reduce<Observation | undefined>(
    (current, observation) =>
      current === undefined || observation.probability < current.probability ? observation : current,
    undefined,
  );
  return {
    verdict: "allow",
    rationale:
      lowest === undefined
        ? "No safety conditions applied."
        : `No hazard was evident across ${observations.length} conditions (lowest p=${formatProbability(lowest.probability)} on ${lowest.ruleId}).`,
    probabilities,
    clearedByIntent: [],
  };
}
