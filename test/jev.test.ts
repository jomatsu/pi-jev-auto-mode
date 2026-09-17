import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildGatedCall, type GatedCall, type RepoFacts } from "../src/call.ts";
import type { CandidateInput } from "../src/decide.ts";
import { DEFAULT_RULES, applyThresholdOverrides, buildQuestions, ruleById, rulesForTool, type JevRule } from "../src/jev/questions.ts";
import { classifyCondition, combine, observe } from "../src/jev/decide.ts";
import { parseAnswers } from "../src/jev/response.ts";
import { createJevEngine } from "../src/jev/engine.ts";
import { createSdkTransport, verifyApiKey } from "../src/jev/transport.ts";
import { describeJevAvailability } from "../src/jev/availability.ts";
import type { JevRequest, JevTransport, JevTransportResult } from "../src/jev/types.ts";

const CWD = "/Users/dev/project";
const REPO: RepoFacts = { cwd: CWD, isGitRepository: true, protectedPaths: [".git", ".ssh", ".pi"] };

const REQUIRED: JevRule = {
  id: "intent_coverage",
  label: "within the request",
  question: "requested?",
  denyMessage: "The call is not part of what the user asked for.",
  uncertainMessage: "It is not clear whether the request covers this call.",
  mode: "required",
  severity: "hazard",
  threshold: 0.8,
};

const SOFT: JevRule = {
  id: "no_outward_effect",
  label: "outward effect",
  question: "no outward effect?",
  denyMessage: "The call acts on something outside this machine.",
  uncertainMessage: "It is not clear whether the call affects anything outside this machine.",
  mode: "hazard",
  severity: "soft",
  threshold: 0.9,
};

const HARD: JevRule = {
  id: "no_secret_egress",
  label: "secret egress",
  question: "no secret egress?",
  denyMessage: "The call sends secret material to a network endpoint.",
  uncertainMessage: "It is not clear whether the call transmits secret material.",
  mode: "hazard",
  severity: "hazard",
  threshold: 0.97,
};

function bashCall(command: string): GatedCall {
  return buildGatedCall({ toolName: "bash", input: { command } }, { cwd: CWD }) as GatedCall;
}

function candidate(call: GatedCall, policy = ""): CandidateInput {
  return { call, reasons: ["git reset hard"], intent: "rebase my working branch", policy, repo: REPO };
}
describe("condition classification", () => {
  it("uses two symmetric thresholds and keeps the middle band", () => {
    assert.equal(classifyCondition(0.95, 0.95), "satisfied");
    assert.equal(classifyCondition(0.94, 0.95), "uncertain");
    assert.equal(classifyCondition(0.5, 0.95), "uncertain");
    assert.equal(classifyCondition(0.06, 0.95), "uncertain");
    assert.equal(classifyCondition(0.05, 0.95), "rejected");
    assert.equal(classifyCondition(0.9, 0.9), "satisfied");
    assert.equal(classifyCondition(0.1, 0.9), "rejected");
  });

  it("is not tripped up by the floating-point form of the boundary", () => {
    // 1 - 0.9 is 0.09999999999999998, so an exact comparison would report the
    // boundary itself as uncertain.
    assert.equal(classifyCondition(1 - 0.9, 0.9), "rejected");
    assert.equal(classifyCondition(0.99, 0.99), "satisfied");
  });

  it("keeps a strict threshold strict", () => {
    // t = 0.97 rejects only at p <= 0.03.
    assert.equal(classifyCondition(0.04, 0.97), "uncertain");
    assert.equal(classifyCondition(0.03, 0.97), "rejected");
  });

  it("keeps the raw band and the effective verdict apart for hazard-mode conditions", () => {
    // An absence-of-hazard question answering 0.7 means "no hazard is evident",
    // not "a hazard is present", so it must not escalate. The raw band is kept so
    // records can show that it was ignored rather than passed.
    const soft = observe([SOFT], { no_outward_effect: 0.7 })[0];
    assert.equal(soft?.verdict, "uncertain");
    assert.equal(soft?.effective, "satisfied");

    const hard = observe([HARD], { no_secret_egress: 0.7 })[0];
    assert.equal(hard?.verdict, "uncertain");
    assert.equal(hard?.effective, "satisfied");

    const required = observe([REQUIRED], { intent_coverage: 0.7 })[0];
    assert.equal(required?.verdict, "uncertain");
    assert.equal(required?.effective, "uncertain");
  });

  it("still rejects a hazard-mode condition on a clear negative", () => {
    const observation = observe([SOFT], { no_outward_effect: 0.05 })[0];
    assert.equal(observation?.verdict, "rejected");
    assert.equal(observation?.effective, "rejected");
  });

  it("treats a missing answer as a rejection rather than an approval", () => {
    assert.deepEqual(observe([SOFT], {})[0]?.effective, "rejected");
  });
});

describe("composition", () => {
  it("denies when the request does not cover the call", () => {
    const combined = combine([REQUIRED, SOFT], observe([REQUIRED, SOFT], { intent_coverage: 0.05, no_outward_effect: 1 }));
    assert.equal(combined.verdict, "deny");
    assert.match(combined.rationale, /not part of what the user asked for/);
  });

  it("escalates when a required condition is unclear", () => {
    const combined = combine([REQUIRED, SOFT], observe([REQUIRED, SOFT], { intent_coverage: 0.5, no_outward_effect: 1 }));
    assert.equal(combined.verdict, "uncertain");
    assert.match(combined.rationale, /not clear whether the request covers/);
  });

  it("clears a soft rejection when the user's own request covers the call", () => {
    const combined = combine([REQUIRED, SOFT], observe([REQUIRED, SOFT], { intent_coverage: 0.97, no_outward_effect: 0.05 }));
    assert.equal(combined.verdict, "allow");
    assert.deepEqual(combined.clearedByIntent, ["no_outward_effect"]);
    assert.match(combined.rationale, /user's request covers this call/);
  });

  it("does not clear a soft rejection without a covering request", () => {
    const combined = combine([REQUIRED, SOFT], observe([REQUIRED, SOFT], { intent_coverage: 0.05, no_outward_effect: 0.05 }));
    assert.equal(combined.verdict, "deny");
  });

  it("never clears a hazard-severity rejection, however clearly the user asked", () => {
    const combined = combine([REQUIRED, HARD], observe([REQUIRED, HARD], { intent_coverage: 0.99, no_secret_egress: 0.01 }));
    assert.equal(combined.verdict, "deny");
    assert.match(combined.rationale, /sends secret material/);
  });

  it("allows when nothing is rejected and nothing is unclear", () => {
    const combined = combine([REQUIRED, SOFT], observe([REQUIRED, SOFT], { intent_coverage: 0.9, no_outward_effect: 0.95 }));
    assert.equal(combined.verdict, "allow");
    assert.deepEqual(combined.clearedByIntent, []);
  });

  it("records every probability", () => {
    const combined = combine([REQUIRED, SOFT], observe([REQUIRED, SOFT], { intent_coverage: 0.9, no_outward_effect: 0.5 }));
    assert.deepEqual(combined.probabilities, { intent_coverage: 0.9, no_outward_effect: 0.5 });
  });
});

describe("question set", () => {
  it("asks one permission question, plus one for the class that needs it", () => {
    const required = DEFAULT_RULES.filter((rule) => rule.mode === "required").map((rule) => rule.id);
    // Only two questions can hold a call back: "is this what the user asked for", and
    // "does this fetch code and run it" for the commands the deterministic layer has
    // already recognised as that shape. Everything else detects hazards and stays quiet
    // unless a hazard is clearly present.
    assert.deepEqual(required, ["intent_coverage", "no_fetched_code_execution"]);
  });

  it("asks the fetched-code question only for a downloaded-script command", () => {
    const piped = rulesForTool("bash", DEFAULT_RULES, { hasPolicy: false, reasons: ["downloaded script execution"] });
    const ordinary = rulesForTool("bash", DEFAULT_RULES, { hasPolicy: false, reasons: ["git reset hard"] });
    assert.ok(piped.some((rule) => rule.id === "no_fetched_code_execution"));
    assert.ok(!ordinary.some((rule) => rule.id === "no_fetched_code_execution"));
  });

  it("gates protected paths only for file tools", () => {
    const bashIds = rulesForTool("bash").map((rule) => rule.id);
    const writeIds = rulesForTool("write").map((rule) => rule.id);
    assert.equal(bashIds.includes("path_not_protected"), false);
    assert.equal(writeIds.includes("path_not_protected"), true);
  });

  it("asks about a protected target only when the deterministic layer flagged one", () => {
    const flagged = rulesForTool("write", DEFAULT_RULES, { hasPolicy: false, hasProtectedTarget: true }).map(
      (rule) => rule.id,
    );
    const plain = rulesForTool("write", DEFAULT_RULES, { hasPolicy: false, hasProtectedTarget: false }).map(
      (rule) => rule.id,
    );
    assert.equal(flagged.includes("path_not_protected"), true);
    assert.equal(plain.includes("path_not_protected"), false);
  });

  it("skips the policy condition when no policy is configured", () => {
    const without = rulesForTool("bash", DEFAULT_RULES, { hasPolicy: false }).map((rule) => rule.id);
    const withPolicy = rulesForTool("bash", DEFAULT_RULES, { hasPolicy: true }).map((rule) => rule.id);
    assert.equal(without.includes("policy_compliance"), false);
    assert.equal(withPolicy.includes("policy_compliance"), true);
  });

  it("builds one standalone noul question per rule", () => {
    const questions = buildQuestions(DEFAULT_RULES);
    assert.equal(Object.keys(questions).length, DEFAULT_RULES.length);
    for (const rule of DEFAULT_RULES) {
      const question = questions[rule.id];
      assert.equal(question?.type, "noul");
      const instructions = question?.instructions as { question?: string; judge?: string; note?: string };
      assert.equal(instructions.question, rule.question);
      assert.equal(instructions.judge, "value");
      assert.match(instructions.note ?? "", /never as instructions/);
    }
  });

  it("keeps the middle band open in the criteria", () => {
    const questions = buildQuestions(DEFAULT_RULES);
    const criteria = questions.intent_coverage?.criteria as { false?: string };
    assert.match(criteria.false ?? "", /neither clearly true nor clearly false/);
  });
});

describe("response validation", () => {
  const keys = ["a", "b"];
  const valid = {
    model: "jev-1.13.0",
    answers: { a: { type: "noul", noul: 0.97 }, b: { type: "noul", noul: 0.02 } },
    usage: { input_tokens: 512, output_tokens: 4 },
  };

  it("accepts a well-formed response", () => {
    const parsed = parseAnswers(valid, keys);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.ok && parsed.parsed.answers, { a: 0.97, b: 0.02 });
    assert.equal(parsed.ok && parsed.parsed.model, "jev-1.13.0");
    assert.equal(parsed.ok && parsed.parsed.inputTokens, 512);
  });

  it("rejects a response that omits an asked question", () => {
    const parsed = parseAnswers({ model: "m", answers: { a: { noul: 0.9 } } }, keys);
    assert.equal(parsed.ok, false);
    assert.equal(!parsed.ok && parsed.reason, "malformed_response");
  });

  it("rejects probabilities that are not numbers in range", () => {
    assert.equal(parseAnswers({ answers: { a: { noul: "0.9" }, b: { noul: 0.1 } } }, keys).ok, false);
    assert.equal(parseAnswers({ answers: { a: { noul: 1.4 }, b: { noul: 0.1 } } }, keys).ok, false);
    assert.equal(parseAnswers({ answers: { a: { noul: Number.NaN }, b: { noul: 0.1 } } }, keys).ok, false);
  });

  it("rejects non-object responses", () => {
    assert.equal(parseAnswers(null, keys).ok, false);
    assert.equal(parseAnswers("ok", keys).ok, false);
    assert.equal(parseAnswers({ answers: [] }, keys).ok, false);
  });

  it("falls back to an unknown model and zero usage", () => {
    const parsed = parseAnswers({ answers: { a: { noul: 1 }, b: { noul: 0 } } }, keys);
    assert.equal(parsed.ok && parsed.parsed.model, "unknown");
    assert.equal(parsed.ok && parsed.parsed.inputTokens, 0);
  });
});

function stubTransport(result: JevTransportResult): { transport: JevTransport; requests: JevRequest[] } {
  const requests: JevRequest[] = [];
  return {
    requests,
    transport: {
      systemOne: async (request) => {
        requests.push(request);
        return result;
      },
    },
  };
}

function answerBody(probabilities: Readonly<Record<string, number>>): unknown {
  const answers: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(probabilities)) answers[key] = { type: "noul", noul: value };
  return { model: "jev-1.13.0", answers, usage: { input_tokens: 700, output_tokens: 8 } };
}

/** A file write that the deterministic layer flagged as protected. */
function protectedWrite(): GatedCall {
  return buildGatedCall({ toolName: "write", input: { path: ".env", content: "x" } }, { cwd: CWD }) as GatedCall;
}

/** Every condition the engine will ask with no policy configured. */
function askedRules(tool: "bash" | "write", protectedTarget = false): readonly JevRule[] {
  return rulesForTool(tool, DEFAULT_RULES, { hasPolicy: false, hasProtectedTarget: protectedTarget });
}

function satisfiedFor(tool: "bash" | "write", protectedTarget = false): Record<string, number> {
  const probabilities: Record<string, number> = {};
  for (const rule of askedRules(tool, protectedTarget)) probabilities[rule.id] = 1;
  return probabilities;
}

describe("engine", () => {
  it("approves when nothing is hazardous and the request covers the call", async () => {
    const { transport, requests } = stubTransport({ ok: true, response: answerBody(satisfiedFor("bash")) });
    const engine = createJevEngine({ transport, now: () => 100 });
    const verdict = await engine.judge(candidate(bashCall("git reset --hard HEAD~1")), {});

    assert.equal(verdict.verdict, "allow");
    assert.equal(verdict.model, "jev-1.13.0");
    assert.equal(requests.length, 1, "one judgment is one request");

    const state = requests[0]?.state as { value: Record<string, unknown>; context: Record<string, unknown> };
    assert.equal(state.value.command, "git reset --hard HEAD~1");
    assert.equal(state.value.user_intent, "rebase my working branch");
    assert.equal((state.context.repository as { cwd: string }).cwd, CWD);
  });

  it("denies when a hazard is clearly present, even though the user asked", async () => {
    const probabilities = { ...satisfiedFor("bash"), no_secret_egress: 0.01 };
    const { transport } = stubTransport({ ok: true, response: answerBody(probabilities) });
    const engine = createJevEngine({ transport });

    const verdict = await engine.judge(candidate(bashCall("git reset --hard HEAD~1")), {});
    assert.equal(verdict.verdict, "deny");
    assert.match(verdict.rationale, /sends secret material/);
    assert.equal(verdict.probabilities?.no_secret_egress, 0.01);
  });

  it("clears a soft hazard when the request covers the call", async () => {
    const probabilities = { ...satisfiedFor("bash"), no_outward_effect: 0.05 };
    const { transport } = stubTransport({ ok: true, response: answerBody(probabilities) });
    const engine = createJevEngine({ transport });

    const verdict = await engine.judge(candidate(bashCall("git push --force origin feature/x")), {});
    assert.equal(verdict.verdict, "allow");
    assert.match(verdict.rationale, /request covers this call/);
  });

  it("escalates when the request itself is unclear", async () => {
    const probabilities = { ...satisfiedFor("bash"), intent_coverage: 0.5 };
    const { transport } = stubTransport({ ok: true, response: answerBody(probabilities) });
    const engine = createJevEngine({ transport });

    const verdict = await engine.judge(candidate(bashCall("git reset --hard HEAD~1")), {});
    assert.equal(verdict.verdict, "uncertain");
    assert.match(verdict.rationale, /request covers this call/);
  });

  it("reports every condition to the calibration hook, including passing ones", async () => {
    const seen: string[] = [];
    const { transport } = stubTransport({ ok: true, response: answerBody(satisfiedFor("bash")) });
    const engine = createJevEngine({
      transport,
      onObservation: (observations, meta) => {
        seen.push(...observations.map((observation) => observation.ruleId));
        assert.equal(meta.model, "jev-1.13.0");
        assert.equal(meta.inputTokens, 700);
      },
    });

    await engine.judge(candidate(bashCall("git reset --hard HEAD~1")), {});
    assert.equal(seen.length, askedRules("bash").length);
    assert.ok(seen.includes("local_scope"));
  });

  it("asks the policy condition once a policy is configured", async () => {
    const { transport, requests } = stubTransport({ ok: true, response: answerBody({}) });
    const engine = createJevEngine({ transport });
    await engine.judge(candidate(bashCall("git reset --hard HEAD~1"), "never rewrite published history"), {});
    assert.ok(Object.keys(requests[0]?.questions ?? {}).includes("policy_compliance"));
  });

  it("asks about protected paths for a flagged file tool and denies a credential target", async () => {
    const probabilities = { ...satisfiedFor("write", true), path_not_protected: 0.01 };

    const { transport, requests } = stubTransport({ ok: true, response: answerBody(probabilities) });
    const engine = createJevEngine({ transport });
    const verdict = await engine.judge(candidate(protectedWrite()), {});

    assert.equal(verdict.verdict, "deny");
    assert.ok(Object.keys(requests[0]?.questions ?? {}).includes("path_not_protected"));
  });

  it("lets the request decide when protection is unclear", async () => {
    // 0.28 is neither "protected" nor "not protected". The target was already escalated
    // because the deterministic layer distrusts it, so an unclear answer must not block
    // on its own: the user's request is the thing that makes the write legitimate.
    const probabilities = { ...satisfiedFor("write", true), path_not_protected: 0.28 };

    const { transport } = stubTransport({ ok: true, response: answerBody(probabilities) });
    const engine = createJevEngine({ transport });
    assert.equal((await engine.judge(candidate(protectedWrite()), {})).verdict, "allow");

    const rejected = { ...probabilities, intent_coverage: 0.05 };
    const { transport: second } = stubTransport({ ok: true, response: answerBody(rejected) });
    const otherEngine = createJevEngine({ transport: second });
    const verdict = await otherEngine.judge(candidate(protectedWrite()), {});
    assert.equal(verdict.verdict, "deny");
    assert.match(verdict.rationale, /not part of what the user asked for/);
  });

  it("fails closed when the transport reports a failure", async () => {
    const { transport } = stubTransport({ ok: false, reason: "timeout" });
    const engine = createJevEngine({ transport });
    const verdict = await engine.judge(candidate(bashCall("git reset --hard HEAD~1")), {});

    assert.equal(verdict.verdict, "unavailable");
    assert.equal(verdict.verdict === "unavailable" && verdict.reason, "timeout");
  });

  it("fails closed when the response cannot be trusted", async () => {
    const { transport } = stubTransport({ ok: true, response: { model: "m", answers: {} } });
    const engine = createJevEngine({ transport });
    const verdict = await engine.judge(candidate(bashCall("git reset --hard HEAD~1")), {});

    assert.equal(verdict.verdict, "unavailable");
    assert.equal(verdict.verdict === "unavailable" && verdict.reason, "malformed_response");
  });

  it("refuses to send a request over the state budget", async () => {
    const { transport, requests } = stubTransport({ ok: true, response: answerBody(satisfiedFor("bash")) });
    const engine = createJevEngine({ transport, maxStateCharacters: 50 });
    const verdict = await engine.judge(candidate(bashCall("git reset --hard HEAD~1")), {});

    assert.equal(verdict.verdict, "unavailable");
    assert.equal(verdict.verdict === "unavailable" && verdict.reason, "state_too_large");
    assert.deepEqual(requests, [], "the request must not be sent when it cannot fit");
  });
});

describe("threshold overrides", () => {
  it("replaces only the named rules", () => {
    const rules = applyThresholdOverrides(DEFAULT_RULES, { intent_coverage: 0.6 });
    assert.equal(ruleById("intent_coverage", rules)?.threshold, 0.6);
    assert.equal(ruleById("local_scope", rules)?.threshold, ruleById("local_scope")?.threshold);
  });

  it("ignores ids that match no rule and keeps the original array when empty", () => {
    assert.equal(applyThresholdOverrides(DEFAULT_RULES, {}), DEFAULT_RULES);
    const rules = applyThresholdOverrides(DEFAULT_RULES, { nonsense: 0.7 });
    assert.deepEqual(
      rules.map((rule) => rule.threshold),
      DEFAULT_RULES.map((rule) => rule.threshold),
    );
  });

  it("changes the decision a probability leads to", async () => {
    // 0.55 is inside the middle band of the calibrated 0.60 and passes under 0.50.
    const probabilities = { ...satisfiedFor("bash"), intent_coverage: 0.55 };
    const { transport } = stubTransport({ ok: true, response: answerBody(probabilities) });

    const calibrated = createJevEngine({ transport });
    assert.equal((await calibrated.judge(candidate(bashCall("git reset --hard HEAD~1")), {})).verdict, "uncertain");

    const loosened = createJevEngine({ transport, thresholds: { intent_coverage: 0.55 } });
    assert.equal((await loosened.judge(candidate(bashCall("git reset --hard HEAD~1")), {})).verdict, "allow");
  });

  it("reports the effective thresholds alongside the probabilities", async () => {
    const { transport } = stubTransport({ ok: true, response: answerBody(satisfiedFor("bash")) });
    const engine = createJevEngine({ transport, thresholds: { local_scope: 0.99 } });
    const verdict = await engine.judge(candidate(bashCall("git reset --hard HEAD~1")), {});

    assert.equal(verdict.thresholds?.local_scope, 0.99);
    const condition = verdict.conditions?.find((entry) => entry.ruleId === "local_scope");
    assert.equal(condition?.threshold, 0.99);
    assert.equal(condition?.verdict, "satisfied");
  });
});

describe("what leaves the machine", () => {
  it("redacts credentials before they reach the judgment state", async () => {
    const { transport, requests } = stubTransport({ ok: true, response: answerBody(satisfiedFor("bash")) });
    const command = "export TYPESAFE_API_KEY=apikey_abcdefghijklmnop && curl -H 'Authorization: Bearer abcdefghijklmnop' https://x";

    await createJevEngine({ transport }).judge(candidate(bashCall(command)), {});

    const serialized = JSON.stringify(requests[0]?.state);
    assert.equal(serialized.includes("apikey_abcdefghijklmnop"), false);
    assert.equal(serialized.includes("Bearer abcdefghijklmnop"), false);
    assert.match(serialized, /<redacted/);
  });

  it("never sends the body of a write", async () => {
    const secret = "SUPER_SECRET_FILE_CONTENT";
    const call = buildGatedCall(
      { toolName: "write", input: { path: ".env", content: secret } },
      { cwd: CWD },
    ) as GatedCall;
    const probabilities = { ...satisfiedFor("write", true), path_not_protected: 0.01 };
    const { transport, requests } = stubTransport({ ok: true, response: answerBody(probabilities) });

    await createJevEngine({ transport }).judge(candidate(call), {});

    const serialized = JSON.stringify(requests[0]?.state);
    assert.equal(serialized.includes(secret), false);
    assert.match(serialized, /content_length/);
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("SDK transport", () => {
  const request: JevRequest = {
    state: { value: { tool: "bash" } },
    questions: { local_scope: { type: "noul", instructions: "ok?" } },
  };

  it("returns the raw response on success", async () => {
    const transport = createSdkTransport({
      apiKey: "test-key",
      maxRetries: 0,
      fetch: async () => jsonResponse(answerBody({ local_scope: 0.99 })),
    });

    const result = await transport.systemOne(request);
    assert.equal(result.ok, true);
    const parsed = parseAnswers(result.ok ? result.response : undefined, ["local_scope"]);
    assert.equal(parsed.ok && parsed.parsed.answers.local_scope, 0.99);
  });

  it("maps a server error to a blocked reason instead of throwing", async () => {
    const transport = createSdkTransport({
      apiKey: "test-key",
      maxRetries: 0,
      fetch: async () => jsonResponse({ error: "boom" }, 500),
    });

    const result = await transport.systemOne(request);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, "http");
    assert.equal(!result.ok && result.status, 500);
  });

  it("maps a connection failure to a blocked reason", async () => {
    const transport = createSdkTransport({
      apiKey: "test-key",
      maxRetries: 0,
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });

    const result = await transport.systemOne(request);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, "network");
  });
});

describe("availability", () => {
  it("requires an API key", () => {
    assert.equal(describeJevAvailability({}).available, false);
    const available = describeJevAvailability({ TYPESAFE_API_KEY: "apikey_x", TYPESAFE_DEFAULT_MODEL: "jev-latest" });
    assert.equal(available.available, true);
    assert.equal(available.model, "jev-latest");
    assert.equal(available.source, "env");
  });

  it("defaults the model name", () => {
    assert.equal(describeJevAvailability({ TYPESAFE_API_KEY: "k" }).model, "jev-latest");
  });

  it("uses the stored secret when the environment has none", () => {
    const availability = describeJevAvailability({}, "apikey_stored");
    assert.equal(availability.available, true);
    assert.equal(availability.apiKey, "apikey_stored");
    assert.equal(availability.source, "stored");
  });

  it("lets an environment key win over the stored secret", () => {
    // A one-off or CI override must not require touching the stored credential.
    const availability = describeJevAvailability({ TYPESAFE_API_KEY: "apikey_env" }, "apikey_stored");
    assert.equal(availability.apiKey, "apikey_env");
    assert.equal(availability.source, "env");
  });

  it("reports how to fix a missing key", () => {
    const availability = describeJevAvailability({});
    assert.equal(availability.source, "none");
    assert.match(availability.reason ?? "", /\/jev-auto-mode login/);
  });
});

describe("API key verification", () => {
  const listResponse = { models: [{ name: "jev-latest" }] };

  it("accepts a key the API answers with", async () => {
    const result = await verifyApiKey({ apiKey: "k", fetch: async () => jsonResponse(listResponse) });
    assert.deepEqual(result, { ok: true });
  });

  it("rejects a key the API refuses", async () => {
    const unauthorized = await verifyApiKey({ apiKey: "k", fetch: async () => jsonResponse({ error: "no" }, 401) });
    assert.deepEqual(unauthorized, { ok: false, reason: "invalid" });
    const forbidden = await verifyApiKey({ apiKey: "k", fetch: async () => jsonResponse({ error: "no" }, 403) });
    assert.deepEqual(forbidden, { ok: false, reason: "invalid" });
  });

  it("reports an unreachable API without blaming the key", async () => {
    const offline = await verifyApiKey({
      apiKey: "k",
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    assert.deepEqual(offline, { ok: false, reason: "unreachable" });

    const serverError = await verifyApiKey({ apiKey: "k", fetch: async () => jsonResponse({ error: "boom" }, 500) });
    assert.deepEqual(serverError, { ok: false, reason: "unreachable" });
  });

  it("reports a response it cannot trust as unreachable", async () => {
    const nonsense = await verifyApiKey({ apiKey: "k", fetch: async () => jsonResponse({ nope: true }) });
    assert.deepEqual(nonsense, { ok: false, reason: "unreachable" });
  });
});
