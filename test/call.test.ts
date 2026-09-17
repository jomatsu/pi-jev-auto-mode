import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildGatedCall,
  redactSecrets,
  toJevState,
  truncate,
  type GatedCall,
  type RepoFacts,
} from "../src/call.ts";

const CWD = "/Users/dev/project";
const REPO: RepoFacts = { cwd: CWD, isGitRepository: true, protectedPaths: [".git", ".ssh", ".pi"] };

describe("redaction", () => {
  it("removes common credential shapes", () => {
    assert.match(redactSecrets("export TYPESAFE_API_KEY=apikey_abcdefghijklmnop"), /<redacted/);
    assert.equal(redactSecrets("Authorization: Bearer abcdefghijklmnopqrstuvwxyz"), "Authorization: Bearer <redacted>");
    assert.equal(
      redactSecrets("-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----"),
      "<redacted-private-key>",
    );
    assert.match(redactSecrets("token=ghp_abcdefghijklmnopqrstuvwxyz01"), /<redacted/);
  });

  it("leaves ordinary text untouched", () => {
    assert.equal(redactSecrets("uv run pytest -q"), "uv run pytest -q");
  });
});

describe("truncate", () => {
  it("marks that content was cut", () => {
    assert.equal(truncate("abcdef", 3), "abc...");
    assert.equal(truncate("abc", 3), "abc");
  });
});

describe("buildGatedCall", () => {
  it("ignores tools the gate does not cover", () => {
    assert.equal(
      buildGatedCall({ toolName: "read", input: { path: "a.ts" } }, { cwd: CWD }),
      undefined,
    );
  });

  it("redacts and truncates bash commands", () => {
    const call = buildGatedCall(
      { toolName: "bash", input: { command: "curl -H 'Authorization: Bearer abcdefghijklmnop' https://x" } },
      { cwd: CWD, maxCommandLength: 20 },
    );
    assert.equal(call?.tool, "bash");
    assert.match(call?.command ?? "", /<redacted>|\.\.\.$/);
    assert.equal(call?.outsideCwd, false);
  });

  it("keeps the first line as a summary", () => {
    const call = buildGatedCall({ toolName: "bash", input: { command: "npm run build\necho done" } }, { cwd: CWD });
    assert.equal(call?.summary, "npm run build");
  });

  it("describes a write without sending its content", () => {
    const call = buildGatedCall(
      { toolName: "write", input: { path: "src/new.ts", content: "x".repeat(120) } },
      { cwd: CWD },
    );
    assert.equal(call?.path, `${CWD}/src/new.ts`);
    assert.equal(call?.relativePath, "src/new.ts");
    assert.equal(call?.contentLength, 120);
    assert.equal(call?.protectedReason, undefined);
  });

  it("flags protected writes", () => {
    const call = buildGatedCall({ toolName: "edit", input: { path: ".env", edits: [] } }, { cwd: CWD });
    assert.equal(call?.protectedReason, "protected file `.env`");
    assert.equal(call?.editCount, 0);
  });
});

describe("toJevState", () => {
  const call = buildGatedCall({ toolName: "bash", input: { command: "git push --force" } }, { cwd: CWD }) as GatedCall;

  it("keeps the call and intent in value, and the policy in context", () => {
    const state = toJevState({ call, reasons: ["git force push"], intent: "rebase my branch", policy: "never push", repo: REPO });
    const value = state.value as Record<string, unknown>;
    const context = state.context as Record<string, unknown>;

    assert.equal(value.tool, "bash");
    assert.equal(value.command, "git push --force");
    assert.deepEqual(value.matched_policy_reasons, ["git force push"]);
    assert.equal(value.user_intent, "rebase my branch");
    assert.equal(context.policy, "never push");
    assert.deepEqual((context.repository as Record<string, unknown>).cwd, CWD);
  });

  it("substitutes placeholders so a condition never reads an empty string", () => {
    const state = toJevState({ call, reasons: [], intent: "   ", policy: "", repo: REPO });
    const value = state.value as Record<string, unknown>;
    const context = state.context as Record<string, unknown>;

    assert.equal(value.user_intent, "(no recent user message available)");
    assert.equal(context.policy, "(no user policy configured)");
  });

  it("stays JSON-serializable", () => {
    const state = toJevState({ call, reasons: ["x"], intent: "y", policy: "z", repo: REPO });
    assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
  });
});
