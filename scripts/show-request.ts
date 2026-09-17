/**
 * Print exactly what a judgment sends to the API.
 *
 * Answers "how much context does the gate hand over?" with the real payload rather
 * than a description of it. Not part of the published package.
 *
 *   node --experimental-strip-types scripts/show-request.ts
 */

import { buildGatedCall, type GatedCall, type RepoFacts } from "../src/call.ts";
import type { CandidateInput } from "../src/decide.ts";
import { extractRecentIntent } from "../src/intent.ts";
import { createJevEngine } from "../src/jev/engine.ts";
import type { JevRequest } from "../src/jev/types.ts";

const CWD = "/Users/dev/project";
const REPO: RepoFacts = { cwd: CWD, isGitRepository: true, protectedPaths: [".git", ".ssh", ".pi"] };

const call = buildGatedCall(
  { toolName: "bash", input: { command: process.argv[2] ?? "git reset --hard HEAD~1" } },
  { cwd: CWD },
) as GatedCall;

// A realistic session, including assistant text and tool output that must not be sent.
const branch = [
  { type: "message", message: { role: "user", content: "add a health check endpoint to the api" } },
  { type: "message", message: { role: "assistant", content: [{ type: "text", text: "ASSISTANT_MARKER" }] } },
  { type: "message", message: { role: "tool", content: "TOOL_OUTPUT_MARKER" } },
  { type: "message", message: { role: "user", content: "and clean up my branch while you are there" } },
];

let captured: JevRequest | undefined;
const engine = createJevEngine({
  transport: {
    systemOne: async (request) => {
      captured = request;
      return { ok: false, reason: "timeout" };
    },
  },
});

const input: CandidateInput = {
  call,
  reasons: ["git reset hard"],
  intent: extractRecentIntent(branch),
  policy: "",
  repo: REPO,
};

await engine.judge(input, {});
if (!captured) throw new Error("no request captured");

const { state, questions } = captured;
const size = (value: unknown): number => JSON.stringify(value).length;
const value = state.value as Record<string, unknown>;
const context = state.context as Record<string, unknown>;

const rows: Array<[string, number]> = [
  ["value.command (redacted, truncated)", String(value.command ?? "").length],
  ["value.user_intent (user turns only)", String(value.user_intent ?? "").length],
  ["value.operation + reasons", size({ operation: value.operation, reasons: value.matched_policy_reasons })],
  ["context.policy (your notes)", String(context.policy ?? "").length],
  ["context.repository", size(context.repository)],
  ["questions (8 noul + criteria)", size(questions)],
];

process.stdout.write("field                                        chars\n");
process.stdout.write("-------------------------------------------  -----\n");
for (const [label, count] of rows) process.stdout.write(`${label.padEnd(44)} ${String(count).padStart(5)}\n`);
const total = size({ state, questions });
process.stdout.write(`\nstate + questions total                      ${String(total).padStart(5)} chars (~${Math.round(total / 4)} tokens)\n`);
process.stdout.write("request budget (maxStateCharacters)           120000 chars\n\n");

const serialized = JSON.stringify({ state, questions });
for (const marker of ["ASSISTANT_MARKER", "TOOL_OUTPUT_MARKER"]) {
  process.stdout.write(`${marker.padEnd(20)} in the request: ${serialized.includes(marker)}\n`);
}

process.stdout.write("\n=== full request ===\n");
process.stdout.write(`${JSON.stringify({ state, questions }, null, 2)}\n`);
