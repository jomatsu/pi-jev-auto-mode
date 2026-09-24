import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ConditionReport } from "../src/decide.ts";
import { formatConditionLines, formatDecisionLine, type DecisionRecord } from "../src/records.ts";
import {
  buildConfirmationDialog,
  clampLines,
  formatRuleTable,
  previewCommand,
  statusText,
  type ObservedCondition,
} from "../src/ui.ts";
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
    assert.equal(statusText({ enabled: true, engineId: "manual", scope: "project" }), "🛡 jev no key (project)");
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
    assert.match(table, /intent_coverage\s+hazard\s+hazard\s+0\.60 override \(default 0\.60\)\s+p=0\.97 \(satisfied\)/);
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
    assert.match(raised, /intent_coverage\s+hazard\s+hazard\s+0\.99 override \(default 0\.60\)\s+p=0\.97 \(ignored\)/);
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
    assert.match(table, /intent_coverage\s+hazard\s+hazard\s+0\.60 default\s+-/);
  });
});

describe("confirmation dialogs", () => {
  const longCommand = Array.from({ length: 60 }, (_, i) => `# padding line ${i + 1}`).join("\n") + "\nsudo -n true";

  it("bounds a long command to a preview and says what was hidden", () => {
    const preview = previewCommand(longCommand);
    assert.equal(preview.lines.length, 6);
    assert.equal(preview.truncated, true);
    assert.equal(preview.hiddenLines, 55);
    assert.ok(preview.hiddenCharacters > 0);
  });

  it("bounds a single very long line and counts what was cut", () => {
    const preview = previewCommand("echo " + "x".repeat(5000), { maxLines: 6, maxLineLength: 40 });
    assert.equal(preview.lines[0]?.length, 41);
    assert.match(preview.lines[0] ?? "", /…$/);
    assert.equal(preview.hiddenLines, 0);
    assert.ok(preview.hiddenCharacters > 4900);
    assert.equal(preview.truncated, true);
  });

  it("does not claim truncation when nothing was cut", () => {
    const preview = previewCommand("sudo -n true");
    assert.equal(preview.truncated, false);
    assert.equal(preview.hiddenCharacters, 0);
  });

  it("keeps the whole dialog short, which is what the TUI needs", () => {
    // Pi's dialogs do not clip their content: an oversized title pushes the dialog's
    // own heading off screen and makes the terminal scroll back and forth.
    const dialog = buildConfirmationDialog({
      tool: "bash",
      command: longCommand,
      reasons: ["sudo", "package execution or publish", "git force push"],
      rationale: "It is not clear whether the user's request covers this call. within the request (p=0.73)",
    });

    const lines = dialog.split("\n");
    assert.ok(lines.length <= 14, `dialog was ${lines.length} lines`);
    assert.match(dialog, /^Jev auto mode wants confirmation/);
    assert.match(dialog, /more line\(s\).*the full command is in the tool call above/);
    assert.ok(!dialog.includes("# padding line 60"));
  });

  it("stays short for a write, where no command is involved", () => {
    const dialog = buildConfirmationDialog({
      tool: "write",
      path: "/Users/dev/project/.env",
      reasons: ["protected file `.env`"],
      rationale: "It is not clear whether the write target is protected. (p=0.25)",
    });
    assert.ok(dialog.split("\n").length <= 14);
    assert.match(dialog, /Tool: write/);
    assert.match(dialog, /\.env/);
  });

  it("clamps a block that is over budget even when the parts are small", () => {
    const clamped = clampLines(Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n"), 5);
    assert.equal(clamped.split("\n").length, 5);
    assert.match(clamped, /more lines/);
  });

  it("leaves a short dialog untouched", () => {
    const short = "one\ntwo";
    assert.equal(clampLines(short, 5), short);
  });
});

describe("compact decision records", () => {
  it("folds an approval into one line with the command on it", async () => {
    const { formatCompactLines } = await import("../src/records.ts");
    const lines = formatCompactLines(
      record({ summary: "cd /tmp &&\n  python3 -c \"print(1)\"", latencyMs: 299.4, model: "jev-1.13.0" }),
    );
    assert.equal(lines.headline, '🛡 jev allowed · bash · 299ms · cd /tmp && python3 -c "print(1)"');
    assert.equal(lines.detail, undefined);
  });

  it("keeps the rationale for a block, because the user has to act on it", async () => {
    const { formatCompactLines } = await import("../src/records.ts");
    const lines = formatCompactLines(
      record({ status: "blocked", source: "hard-deny", rationale: "Deletes\nhistory.", latencyMs: undefined }),
    );
    assert.equal(lines.headline, "⛔ jev blocked · bash · via hard-deny · git reset --hard HEAD~1");
    assert.equal(lines.detail, "Deletes history.");
  });
});

describe("decision entry renderer", () => {
  type Renderer = (entry: { data?: DecisionRecord }, options: { expanded: boolean }, theme: unknown) => { render(width: number): string[] } | undefined;
  const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text };

  async function capture(mode?: "full" | "compact"): Promise<Renderer> {
    const { registerDecisionEntryRenderer } = await import("../src/records.ts");
    let renderer: Renderer | undefined;
    const pi = { registerEntryRenderer: (_: string, fn: Renderer) => (renderer = fn) };
    registerDecisionEntryRenderer(pi as never, mode === undefined ? undefined : () => mode);
    assert.ok(renderer);
    return renderer;
  }

  const long = record({ summary: `cd ${"/very/long/path".repeat(20)} && python3 -c "x"`, latencyMs: 299 });

  it("renders a compact approval as one clipped line", async () => {
    const lines = (await capture("compact"))({ data: long }, { expanded: false }, theme)?.render(60) ?? [];
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? "", /jev allowed · bash · 299ms/);
  });

  it("shows every detail when expanded, even in compact mode", async () => {
    const lines = (await capture("compact"))({ data: long }, { expanded: true }, theme)?.render(60) ?? [];
    assert.ok(lines.some((line) => line.includes("rationale:")));
    assert.ok(lines.length > 5);
  });

  it("keeps the full view by default", async () => {
    const lines = (await capture())({ data: long }, { expanded: false }, theme)?.render(60) ?? [];
    assert.ok(lines.some((line) => line.includes("rationale:")));
    assert.ok(lines.length > 3);
  });
});
