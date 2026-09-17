/**
 * Real-API calibration run.
 *
 * Sends a fixture set of tool calls through the actual Jev questions and prints
 * every condition's probability, so thresholds can be chosen from data instead of
 * taste. Requires `TYPESAFE_API_KEY`.
 *
 *   node --experimental-strip-types scripts/calibrate.ts
 *   node --experimental-strip-types scripts/calibrate.ts --tool bash
 */

import { buildGatedCall, type GatedCall } from "../src/call.ts";
import type { CandidateInput } from "../src/decide.ts";
import { createJevEngine } from "../src/jev/engine.ts";
import { createSdkTransport } from "../src/jev/transport.ts";
import type { Observation } from "../src/jev/decide.ts";
import { FIXTURES, type Fixture } from "./fixtures.ts";

const CWD = process.cwd();

function toCandidate(fixture: Fixture): CandidateInput | undefined {
  const call = buildGatedCall(
    fixture.tool === "bash"
      ? { toolName: "bash", input: { command: fixture.command } }
      : { toolName: fixture.tool, input: { path: fixture.path, content: "x", edits: [] } },
    { cwd: CWD },
  ) as GatedCall | undefined;
  if (!call) return undefined;

  return {
    call,
    reasons: fixture.reasons,
    intent: fixture.intent,
    policy: fixture.policy ?? "",
    repo: { cwd: CWD, isGitRepository: true, protectedPaths: [".git", ".ssh", ".pi"] },
  };
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

async function main(): Promise<void> {
  const toolFilter = process.argv.includes("--tool") ? process.argv[process.argv.indexOf("--tool") + 1] : undefined;

  let observations: readonly Observation[] = [];
  const engine = createJevEngine({
    transport: createSdkTransport({ timeoutMs: 15_000, maxRetries: 1 }),
    onObservation: (seen) => {
      observations = seen;
    },
  });

  const rows: Array<{ label: string; observation: readonly Observation[]; verdict: string }> = [];
  const ruleIds = new Map<string, number>();

  for (const fixture of FIXTURES) {
    if (toolFilter && fixture.tool !== toolFilter) continue;
    const candidate = toCandidate(fixture);
    if (!candidate) continue;

    observations = [];
    const verdict = await engine.judge(candidate, {});
    for (const observation of observations) ruleIds.set(observation.ruleId, observation.threshold);
    rows.push({ label: fixture.label, observation: observations, verdict: verdict.verdict });
    process.stdout.write(
      `\n${fixture.label}\n  expected: ${fixture.expectation}\n  verdict:  ${verdict.verdict} — ${verdict.rationale}\n`,
    );
  }

  const columns = [...ruleIds.keys()];
  process.stdout.write(`\n\n${pad("fixture", 46)}${pad("verdict", 11)}${columns.map((id) => pad(id.slice(0, 12), 14)).join("")}\n`);
  for (const row of rows) {
    const byId = new Map(row.observation.map((observation) => [observation.ruleId, observation.probability]));
    const cells = columns.map((id) => pad(byId.get(id)?.toFixed(2) ?? "-", 14)).join("");
    process.stdout.write(`${pad(row.label.slice(0, 44), 46)}${pad(row.verdict, 11)}${cells}\n`);
  }

  process.stdout.write(`\nthresholds: ${[...ruleIds.entries()].map(([id, value]) => `${id}=${value}`).join(", ")}\n`);
}

await main();
