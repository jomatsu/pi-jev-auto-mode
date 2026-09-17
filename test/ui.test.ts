import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ConditionReport } from "../src/decide.ts";
import { formatConditionLines, formatDecisionLine, type DecisionRecord } from "../src/records.ts";
import { formatRuleTable, statusText, type ObservedCondition } from "../src/ui.ts";
import { DEFAULT_RULES } from "../src/jev/questions.ts";

function condition(patch: Partial<ConditionReport> & { ruleId: string }): ConditionReport {
  return {
    label: patch.ruleId,
    probability: 0.9,
    threshold: 0.8,
    verdict: "satisfied",
    clearedByIntent: false,
    ...patch,
  };
}

function record(patch: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    tool: "bash",
    summary: "git reset --hard HEAD~1",
    reasons: ["git reset hard"],
    status: "allowed",
    source: "engine",
    rationale: "No hazard was evident.",
    timestamp: 1,
    ...patch,
  };
}

describe("decision records", () => {
  it("names the deciding condition in the summary line", () => {
    const line = formatDecisionLine(record({ decidingRule: "no_outward_effect", model: "jev-1.13.0", latencyMs: 412.6 }));
    assert.match(line, /decided by no_outward_effect/);
    assert.match(line, /jev-1\.13\.0/);
    assert.match(line, /413ms/);
  });

  it("shows every condition with its band and threshold bounds", () => {
    const lines = formatConditionLines(
      record({
        decidingRule: "no_outward_effect",
        conditions: [
          condition({ ruleId: "intent_coverage", probability: 0.97, threshold: 0.8 }),
          condition({ ruleId: "no_outward_effect", probability: 0.05, threshold: 0.9, verdict: "rejected", clearedByIntent: true }),
          condition({ ruleId: "local_scope", probability: 0.5, threshold: 0.9, verdict: "ignored" }),
        ],
      }),
    );

    assert.equal(lines.length, 3);
    assert.match(lines[0] ?? "", /intent_coverage\s+p=0\.97\s+pass \(t=0\.80, >= 0\.80\)/);
    assert.match(lines[1] ?? "", /no_outward_effect\s+p=0\.05\s+reject \(t=0\.90, <= 0\.10\) <- decided \(cleared by the user's request\)/);
    assert.match(lines[2] ?? "", /local_scope\s+p=0\.50\s+ignored \(t=0\.90, 0\.10-0\.90\)/);
  });

  it("renders nothing when no condition was recorded", () => {
    assert.deepEqual(formatConditionLines(record()), []);
  });
});

describe("status text", () => {
  it("distinguishes an active gate from the ask-only fallback", () => {
    assert.equal(statusText({ enabled: true, engineId: "jev", scope: "global" }), "🛡 jev (global)");
    assert.equal(statusText({ enabled: true, engineId: "manual", scope: "project" }), "🛡 jev ask-only (project)");
    assert.equal(statusText({ enabled: false, engineId: "jev", scope: "global" }), "🛡 jev off");
  });
});

describe("threshold table", () => {
  const observed = new Map<string, ObservedCondition>([
    ["intent_coverage", { probability: 0.97, at: 1 }],
    ["no_secret_egress", { probability: 0.02, at: 1 }],
  ]);

  it("lists every rule with its mode, severity, and last observed probability", () => {
    const table = formatRuleTable(DEFAULT_RULES, { intent_coverage: 0.6 }, observed);
    assert.match(table, /rule\s+mode\s+severity\s+threshold/);
    assert.match(table, /intent_coverage\s+required\s+hazard\s+0\.60 override \(default 0\.80\)\s+p=0\.97 \(satisfied\)/);
    assert.match(table, /no_secret_egress\s+hazard\s+hazard\s+0\.97 default\s+p=0\.02 \(rejected\)/);
  });

  it("recomputes the band against the current threshold", () => {
    // Both observations were recorded under the defaults, where p=0.97 passed.
    // Raising the thresholds must show what those same answers would now mean.
    const overrides = { no_secret_egress: 0.99, intent_coverage: 0.99 };
    const raised = formatRuleTable(DEFAULT_RULES, overrides, observed);

    // A hazard rule in the middle band is ignored rather than escalated, and note
    // what raising a threshold does to the other side: at t=0.99 the reject band is
    // p <= 0.01, so the 0.02 answer that used to reject no longer does.
    assert.match(raised, /no_secret_egress\s+hazard\s+hazard\s+0\.99 override \(default 0\.97\)\s+p=0\.02 \(ignored\)/);
    // ...while a required rule in the middle band escalates.
    assert.match(raised, /intent_coverage\s+required\s+hazard\s+0\.99 override \(default 0\.80\)\s+p=0\.97 \(uncertain\)/);
  });

  it("labels a middle-band answer on a hazard rule as ignored", () => {
    const middle = new Map<string, ObservedCondition>([["local_scope", { probability: 0.85, at: 1 }]]);
    const table = formatRuleTable(DEFAULT_RULES, {}, middle);
    assert.match(table, /local_scope\s+hazard\s+soft\s+0\.90 default\s+p=0\.85 \(ignored\)/);
  });

  it("flags an override that matches no known rule", () => {
    const table = formatRuleTable(DEFAULT_RULES, { intent_coverge: 0.6 }, new Map());
    assert.match(table, /match no known rule: intent_coverge/);
  });

  it("shows a dash when a condition has not been observed yet", () => {
    const table = formatRuleTable(DEFAULT_RULES, {}, new Map());
    assert.match(table, /intent_coverage\s+required\s+hazard\s+0\.80 default\s+-/);
  });
});
