import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CandidateInput, DecisionEngine, EngineVerdict } from "../src/decide.ts";
import type { DecisionRecord } from "../src/records.ts";
import {
  createInitialState,
  evaluateToolCall,
  type DecisionDeps,
  type GateContext,
  type GateState,
  type GateUi,
} from "../src/extension.ts";
import { DEFAULT_SETTINGS } from "../src/settings.ts";
import type { ToolCallEventLike } from "../src/call.ts";

const CWD = "/Users/dev/project";

interface UiHarness {
  readonly ui: GateUi;
  readonly notifications: Array<{ message: string; type?: string }>;
  readonly selections: string[];
}

function createUi(options: { answer?: string; input?: string } = {}): UiHarness {
  const notifications: Array<{ message: string; type?: string }> = [];
  const selections: string[] = [];
  const ui: GateUi = {
    notify: (message, type) => {
      notifications.push({ message, type });
    },
    select: async (title) => {
      selections.push(title);
      return options.answer;
    },
    confirm: async () => true,
    input: async () => options.input,
    editor: async () => undefined,
    setStatus: () => {},
  };
  return { ui, notifications, selections };
}

function createContext(
  options: { hasUI?: boolean; branch?: readonly unknown[]; ui?: GateUi; signal?: AbortSignal } = {},
): GateContext {
  return {
    cwd: CWD,
    hasUI: options.hasUI ?? true,
    sessionManager: { getBranch: () => options.branch ?? [] },
    ui: options.ui ?? createUi().ui,
    signal: options.signal,
    isProjectTrusted: () => true,
  };
}

interface Harness {
  readonly deps: DecisionDeps;
  readonly records: DecisionRecord[];
  readonly inputs: CandidateInput[];
}

function createDeps(options: { verdict?: EngineVerdict; engine?: DecisionEngine } = {}): Harness {
  const records: DecisionRecord[] = [];
  const inputs: CandidateInput[] = [];
  const engine: DecisionEngine = options.engine ?? {
    id: "test",
    judge: async (input) => {
      inputs.push(input);
      return options.verdict ?? { verdict: "allow", rationale: "in scope" };
    },
  };
  return { deps: { engine, record: (record) => records.push(record), now: () => 1_700_000_000_000 }, records, inputs };
}

function stateWith(patch: Partial<GateState["settings"]> = {}, policyNotes = ""): GateState {
  return { settings: { ...DEFAULT_SETTINGS, ...patch }, policyNotes, scope: "global" };
}

function bash(command: string): ToolCallEventLike {
  return { toolName: "bash", input: { command } };
}

describe("disabled and out-of-scope calls", () => {
  it("does nothing while auto mode is off", async () => {
    const { deps, records, inputs } = createDeps();
    const result = await evaluateToolCall(bash("rm -rf /"), createContext(), stateWith({ enabled: false }), deps);
    assert.equal(result, undefined);
    assert.deepEqual(records, []);
    assert.deepEqual(inputs, []);
  });

  it("ignores tools the gate does not cover", async () => {
    const { deps, inputs } = createDeps();
    const result = await evaluateToolCall(
      { toolName: "read", input: { path: "a.ts" } },
      createContext(),
      stateWith(),
      deps,
    );
    assert.equal(result, undefined);
    assert.deepEqual(inputs, []);
  });
});

describe("fast path", () => {
  it("lets an ordinary command through without asking the engine", async () => {
    const { deps, records, inputs } = createDeps();
    const result = await evaluateToolCall(bash("git status --short"), createContext(), stateWith(), deps);
    assert.equal(result, undefined);
    assert.deepEqual(records, []);
    assert.deepEqual(inputs, []);
  });

  it("lets a write inside the working directory through", async () => {
    const { deps, inputs } = createDeps();
    const result = await evaluateToolCall(
      { toolName: "write", input: { path: "src/index.ts", content: "x" } },
      createContext(),
      stateWith(),
      deps,
    );
    assert.equal(result, undefined);
    assert.deepEqual(inputs, []);
  });

  it("honours a user-declared safe command without recording it", async () => {
    const { deps, records, inputs } = createDeps();
    const result = await evaluateToolCall(
      bash("uv run pytest -q"),
      createContext(),
      stateWith({ safeCommands: ["uv run pytest*"] }),
      deps,
    );
    assert.equal(result, undefined);
    assert.deepEqual(records, [], "a declared-safe command stays out of the transcript");
    assert.deepEqual(inputs, [], "and out of the semantic layer");
  });

  it("escalates a verification runner that the user has not declared safe", async () => {
    const { deps, inputs } = createDeps();
    await evaluateToolCall(bash("uv run pytest -q"), createContext(), stateWith(), deps);
    assert.deepEqual(inputs[0]?.reasons, ["package execution or publish"]);
  });

  it("lets a read-only command through without asking the engine", async () => {
    const { deps, inputs } = createDeps();
    const result = await evaluateToolCall(bash("ls -la"), createContext(), stateWith(), deps);
    assert.equal(result, undefined);
    assert.deepEqual(inputs, []);
  });

  it("escalates a write to a configured protected path", async () => {
    const { deps, inputs } = createDeps();
    await evaluateToolCall(
      { toolName: "write", input: { path: "ops/secrets.yaml", content: "x" } },
      createContext(),
      stateWith({ extraProtectedPaths: ["secrets.yaml"] }),
      deps,
    );
    assert.deepEqual(inputs[0]?.reasons, ["configured protected path `secrets.yaml`"]);
  });
});

describe("deterministic layer wins before the engine", () => {
  it("blocks a hard-deny command and records why", async () => {
    const { deps, records, inputs } = createDeps({ verdict: { verdict: "allow", rationale: "trust me" } });
    const result = await evaluateToolCall(bash("rm -rf /"), createContext(), stateWith(), deps);
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /Non-negotiable safety rule/);
    assert.equal(records[0]?.source, "hard-deny");
    assert.equal(records[0]?.status, "blocked");
    assert.deepEqual(inputs, [], "the engine must not be able to approve a hard-deny target");
  });

  it("blocks a user disallowed pattern", async () => {
    const { deps, records } = createDeps();
    const result = await evaluateToolCall(
      bash("npm publish --access public"),
      createContext(),
      stateWith({ disallowedCommands: ["npm publish*"] }),
      deps,
    );
    assert.equal(result?.block, true);
    assert.equal(records[0]?.source, "user-rule");
  });

  it("approves a user allowed pattern without the engine", async () => {
    const { deps, records, inputs } = createDeps();
    const result = await evaluateToolCall(
      bash("rm -rf build"),
      createContext(),
      stateWith({ allowedCommands: ["rm -rf build*"] }),
      deps,
    );
    assert.equal(result, undefined);
    assert.equal(records[0]?.status, "allowed");
    assert.deepEqual(inputs, []);
  });

  it("judges an in-repository deletion under the default scope", async () => {
    // Scoped local deletion is not read-only, so `gateScope: all` sends it to Jev.
    const { deps, inputs } = createDeps();
    await evaluateToolCall(bash("rm -rf build"), createContext(), stateWith(), deps);
    assert.deepEqual(inputs[0]?.reasons, ["not on the known-safe list"]);
  });

  it("leaves it on the fast path under the matched scope", async () => {
    const { deps, inputs } = createDeps();
    const result = await evaluateToolCall(bash("rm -rf build"), createContext(), stateWith({ gateScope: "matched" }), deps);
    assert.equal(result, undefined);
    assert.deepEqual(inputs, []);
  });
});

describe("gate scope", () => {
  it("judges a call no pattern describes, and says why", async () => {
    // The hole this scope exists for: `curl -d @file` matched no pattern and once ran
    // unjudged. Nothing else about it changed, so no pattern would have caught it.
    const { deps, inputs } = createDeps();
    await evaluateToolCall(bash("mkdir -p /tmp/notes"), createContext(), stateWith(), deps);
    assert.deepEqual(inputs[0]?.reasons, ["not on the known-safe list"]);
  });

  it("does not judge such a call under the matched scope", async () => {
    const { deps, inputs } = createDeps();
    const result = await evaluateToolCall(
      bash("mkdir -p /tmp/notes"),
      createContext(),
      stateWith({ gateScope: "matched" }),
      deps,
    );
    assert.equal(result, undefined);
    assert.deepEqual(inputs, []);
  });

  it("judges a read-only command that reaches a credential path", async () => {
    // `grep secret ~/.ssh/...` looks like reading, and the built-in read-only list would
    // otherwise fast-path it. A dangerous match is checked first.
    const { deps, inputs } = createDeps();
    await evaluateToolCall(bash("grep -r key ~/.ssh/id_ed25519"), createContext(), stateWith(), deps);
    assert.deepEqual(inputs[0]?.reasons, ["reads a credential file"]);
  });

  it("still lets a user-declared safe command outrank a dangerous match", async () => {
    const { deps, inputs } = createDeps();
    const result = await evaluateToolCall(
      bash("grep -r TODO src"),
      createContext(),
      stateWith({ safeCommands: ["grep -r TODO*"] }),
      deps,
    );
    assert.equal(result, undefined);
    assert.deepEqual(inputs, []);
  });
});

describe("semantic verdicts", () => {
  it("allows a dangerous command the engine approves", async () => {
    const { deps, records, inputs } = createDeps({ verdict: { verdict: "allow", rationale: "matches the request", probabilities: { policy_compliance: 0.98 } } });
    const result = await evaluateToolCall(bash("git reset --hard HEAD~1"), createContext(), stateWith(), deps);
    assert.equal(result, undefined);
    assert.equal(records[0]?.status, "allowed");
    assert.equal(records[0]?.source, "engine");
    assert.deepEqual(records[0]?.probabilities, { policy_compliance: 0.98 });
    assert.deepEqual(inputs[0]?.reasons, ["git reset hard"]);
  });

  it("blocks a rejected command", async () => {
    const { deps, records } = createDeps({ verdict: { verdict: "deny", rationale: "rewrites published history" } });
    const result = await evaluateToolCall(bash("git reset --hard HEAD~1"), createContext(), stateWith(), deps);
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /rewrites published history/);
    assert.equal(records[0]?.status, "blocked");
  });

  it("fails closed when no decision is available, even with a UI", async () => {
    const ui = createUi({ answer: "Yes" });
    const { deps, records } = createDeps({
      verdict: { verdict: "unavailable", reason: "timeout", rationale: "the request timed out" },
    });
    const result = await evaluateToolCall(bash("git clean -fd"), createContext({ ui: ui.ui }), stateWith(), deps);
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /timeout/);
    assert.equal(records[0]?.source, "unavailable");
    assert.deepEqual(ui.selections, [], "an unavailable decision must not fall back to a confirmation prompt");
  });

  it("fails closed when the request is cancelled while the engine is deciding", async () => {
    // The real race: Esc arrives mid-judgment. A verdict that arrives after the
    // cancellation must not be treated as an approval.
    const controller = new AbortController();
    const engine: DecisionEngine = {
      id: "slow",
      judge: async () => {
        controller.abort();
        return { verdict: "allow", rationale: "looks fine" };
      },
    };
    const { deps, records } = createDeps({ engine });

    const result = await evaluateToolCall(
      bash("git clean -fd"),
      createContext({ signal: controller.signal }),
      stateWith(),
      deps,
    );

    assert.equal(result?.block, true);
    assert.equal(records[0]?.status, "blocked");
    assert.equal(records[0]?.source, "unavailable");
    assert.match(records[0]?.rationale ?? "", /cancelled/);
  });

  it("fails closed when the engine throws", async () => {
    const engine: DecisionEngine = {
      id: "broken",
      judge: async () => {
        throw new Error("boom");
      },
    };
    const { deps, records } = createDeps({ engine });
    const result = await evaluateToolCall(bash("git clean -fd"), createContext(), stateWith(), deps);
    assert.equal(result?.block, true);
    assert.equal(records[0]?.source, "unavailable");
    assert.match(records[0]?.rationale ?? "", /engine_error/);
  });

  it("fails closed when the request is cancelled", async () => {
    const { deps, records } = createDeps();
    const controller = new AbortController();
    controller.abort();
    const result = await evaluateToolCall(
      bash("git clean -fd"),
      createContext({ signal: controller.signal }),
      stateWith(),
      deps,
    );
    assert.equal(result?.block, true);
    assert.equal(records[0]?.source, "unavailable");
    assert.match(records[0]?.rationale ?? "", /cancelled/);
  });
});

describe("the uncertain band", () => {
  const uncertain: EngineVerdict = { verdict: "uncertain", rationale: "the intent is not clear" };

  it("blocks by default, without asking and without taking over the screen", async () => {
    // The default is not a prompt: an auto mode that stops to ask has handed the
    // decision back to the human.
    const ui = createUi({ answer: "Yes" });
    const { deps, records } = createDeps({ verdict: uncertain });
    const result = await evaluateToolCall(bash("git clean -fd"), createContext({ ui: ui.ui }), stateWith(), deps);

    assert.equal(result?.block, true);
    assert.equal(records[0]?.source, "uncertain");
    assert.deepEqual(ui.selections, [], "no dialog is shown by default");
    assert.match(records[0]?.rationale ?? "", /resolved to a block/);
  });

  it("allows when configured to trust the band", async () => {
    const { deps, records } = createDeps({ verdict: uncertain });
    const result = await evaluateToolCall(
      bash("git clean -fd"),
      createContext(),
      stateWith({ uncertain: "allow" }),
      deps,
    );
    assert.equal(result, undefined);
    assert.equal(records[0]?.status, "allowed");
    assert.equal(records[0]?.source, "uncertain");
  });

  it("asks, and honours a yes, only when configured to ask", async () => {
    const ui = createUi({ answer: "Yes" });
    const { deps, records } = createDeps({ verdict: uncertain });
    const result = await evaluateToolCall(
      bash("git clean -fd"),
      createContext({ ui: ui.ui }),
      stateWith({ uncertain: "ask" }),
      deps,
    );
    assert.equal(result, undefined);
    assert.equal(records[0]?.status, "confirmed");
    assert.equal(records[0]?.source, "user");
    assert.equal(ui.selections.length, 1);
    assert.match(ui.selections[0] ?? "", /Jev auto mode wants confirmation/);
    assert.match(ui.selections[0] ?? "", /git clean -fd/);
  });

  it("blocks when the user declines", async () => {
    const ui = createUi({ answer: "No" });
    const { deps, records } = createDeps({ verdict: uncertain });
    const result = await evaluateToolCall(
      bash("git clean -fd"),
      createContext({ ui: ui.ui }),
      stateWith({ uncertain: "ask" }),
      deps,
    );
    assert.equal(result?.block, true);
    assert.equal(records[0]?.status, "cancelled");
  });

  it("blocks without a UI when configured to ask", async () => {
    const ui = createUi({ answer: "Yes" });
    const { deps, records } = createDeps({ verdict: uncertain });
    const result = await evaluateToolCall(
      bash("git clean -fd"),
      createContext({ hasUI: false, ui: ui.ui }),
      stateWith({ uncertain: "ask" }),
      deps,
    );
    assert.equal(result?.block, true);
    assert.equal(records[0]?.source, "no-ui");
    assert.deepEqual(ui.selections, []);
  });

  it("keeps a long command from flooding the dialog when asking", async () => {
    const longCommand = Array.from({ length: 60 }, (_, i) => `# padding ${i + 1}`).join("\n") + "\nsudo -n true";
    const ui = createUi({ answer: "No" });
    const { deps } = createDeps({ verdict: uncertain });
    await evaluateToolCall(bash(longCommand), createContext({ ui: ui.ui }), stateWith({ uncertain: "ask" }), deps);

    const dialog = ui.selections[0] ?? "";
    assert.ok(dialog.split("\n").length <= 14, `dialog was ${dialog.split("\n").length} lines`);
    assert.match(dialog, /more line\(s\)/);
  });
});

describe("file tools", () => {
  it("escalates a protected path even inside the working directory", async () => {
    const { deps, inputs } = createDeps();
    await evaluateToolCall(
      { toolName: "edit", input: { path: ".env", edits: [{ oldText: "a", newText: "b" }] } },
      createContext(),
      stateWith(),
      deps,
    );
    assert.deepEqual(inputs[0]?.reasons, ["protected file `.env`"]);
  });

  it("escalates a write that escapes the working directory", async () => {
    const { deps, records, inputs } = createDeps({ verdict: { verdict: "deny", rationale: "outside the project" } });
    const result = await evaluateToolCall(
      { toolName: "write", input: { path: "../outside/file.ts", content: "x" } },
      createContext(),
      stateWith(),
      deps,
    );
    assert.deepEqual(inputs[0]?.reasons, ["write outside the working directory"]);
    assert.equal(result?.block, true);
    assert.equal(records[0]?.status, "blocked");
  });
});

describe("state handed to the engine", () => {
  it("carries the recent user intent and the policy notes", async () => {
    const branch = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "clean up the build directory" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "rm -rf /" }] } },
    ];
    const { deps, inputs } = createDeps();
    await evaluateToolCall(
      bash("git clean -fd"),
      createContext({ branch }),
      stateWith({}, "this machine is disposable"),
      deps,
    );
    assert.equal(inputs[0]?.intent, "clean up the build directory");
    assert.equal(inputs[0]?.policy, "this machine is disposable");
    assert.equal(inputs[0]?.repo.cwd, CWD);
  });
});
