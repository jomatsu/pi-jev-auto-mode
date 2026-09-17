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
    ["intent_coverage", { probability: 0.97, threshold: 0.8, verdict: "pass", at: 1 }],
    ["no_secret_egress", { probability: 0.02, threshold: 0.97, verdict: "reject", at: 1 }],
  ]);

  it("lists every rule with its mode, severity, and last observed probability", () => {
    const table = formatRuleTable(DEFAULT_RULES, { intent_coverage: 0.6 }, observed);
    assert.match(table, /rule\s+mode\s+severity\s+threshold/);
    assert.match(table, /intent_coverage\s+required\s+hazard\s+0\.60 override \(default 0\.80\)\s+p=0\.97 \(pass\)/);
    assert.match(table, /no_secret_egress\s+hazard\s+hazard\s+0\.97 default\s+p=0\.02 \(reject\)/);
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
