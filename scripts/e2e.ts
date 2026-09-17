/**
 * End-to-end gate run over the fixture set.
 *
 * Unlike `scripts/calibrate.ts`, which calls the engine directly, this drives the
 * real `evaluateToolCall` path with the real JEV transport: the deterministic layer,
 * the semantic layer, the block/ask routing, and the decision record. It is the
 * closest thing to a real tool call that can be run without executing anything.
 *
 *   node --experimental-strip-types scripts/e2e.ts
 *   node --experimental-strip-types scripts/e2e.ts --ui     # assume a UI exists, so
 *                                                          # "ask" is exercised too
 */

import { evaluateToolCall, createEngine, createInitialState, type GateContext } from "../src/extension.ts";
import { DEFAULT_SETTINGS } from "../src/settings.ts";
import type { DecisionRecord } from "../src/records.ts";
import type { ToolCallEventLike } from "../src/call.ts";
import { FIXTURES, type Fixture } from "./fixtures.ts";

const CWD = process.cwd();

function toEvent(fixture: Fixture): ToolCallEventLike {
  if (fixture.tool === "bash") return { toolName: "bash", input: { command: fixture.command ?? "" } };
  return { toolName: fixture.tool, input: { path: fixture.path ?? "", content: "x", edits: [] } };
}

async function main(): Promise<void> {
  const interactive = process.argv.includes("--ui");
  const engine = createEngine(DEFAULT_SETTINGS, { onObservation: () => {} });
  if (engine.id === "manual") {
    process.stdout.write("No TypeSafe API key available, so the semantic layer would be ask-only.\n");
    return;
  }

  const records: DecisionRecord[] = [];
  let failures = 0;

  for (const fixture of FIXTURES) {
    const state = createInitialState();
    const ctx: GateContext = {      cwd: CWD,
      hasUI: interactive,
      sessionManager: { getBranch: () => [{ type: "message", message: { role: "user", content: fixture.intent } }] },
      ui: {
        notify: () => {},
        select: async () => "No",
        confirm: async () => false,
        input: async () => undefined,
        editor: async () => undefined,
        setStatus: () => {},
      },
      isProjectTrusted: () => true,
    };

    const before = records.length;
    const result = await evaluateToolCall(toEvent(fixture), ctx, state, {
      engine,
      record: (record) => records.push(record),
      now: () => Date.now(),
    });

    // A fixture that takes the fast path produces no record. Looking at the last
    // record overall would then print the previous fixture's decision.
    const record = records.length > before ? records[records.length - 1] : undefined;
    const gate = result ? "BLOCK" : "RUN";
    const expected = fixture.expectation.split(" ")[0]?.toUpperCase() ?? "";
    const matches =
      expected === "ALLOW" || expected === "RUN"
        ? gate === "RUN"
        : expected === "BLOCK"
          ? gate === "BLOCK"
          : true; // "ask" depends on whether a UI is present
    if (!matches) failures += 1;

    const decided = record?.decidingRule ? ` [${record.decidingRule}]` : "";
    process.stdout.write(
      `${matches ? "ok  " : "MISS"} ${gate.padEnd(5)} ${fixture.label.padEnd(44)} expected ${fixture.expectation}` +
        `${decided}\n      ${record?.source ?? "-"} · ${record?.rationale ?? "no record"}\n`,
    );
  }

  process.stdout.write(
    `\n${FIXTURES.length} fixtures, ${failures} unexpected. Non-executable by design: ` +
      `${FIXTURES.filter((fixture) => fixture.unsafeToExecute).length}\n`,
  );
}

await main();
