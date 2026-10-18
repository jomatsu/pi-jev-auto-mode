import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeDecisionAvailability } from "../src/providers.ts";
import { createEngine, evaluateToolCall, type GateContext } from "../src/extension.ts";
import { DEFAULT_SETTINGS, parseSettingsPatch, type UncertainAction } from "../src/settings.ts";
import type { DecisionRecord } from "../src/records.ts";
import { statusText } from "../src/ui.ts";

const accountId = "1234567890abcdef1234567890abcdef";
const cloudflareEnv = { JEV_AUTO_MODE_PROVIDER: "cloudflare", CLOUDFLARE_AUTH_TOKEN: "cloudflare-test-key", CLOUDFLARE_ACCOUNT_ID: accountId };
const providers = [
  { provider: "perplexity", env: { JEV_AUTO_MODE_PROVIDER: "perplexity", PERPLEXITY_API_KEY: "perplexity-test-key" },
    endpoint: "https://api.perplexity.ai/v1/decisions", requestModel: "pplx-decider-v1-27b", responseModel: "pplx-decider-v1-27b", key: "perplexity-test-key" },
  { provider: "cloudflare", env: cloudflareEnv,
    endpoint: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/cloudflare/clef`, requestModel: "clef", responseModel: "clef", key: "cloudflare-test-key" },
  { provider: "strands", env: { JEV_AUTO_MODE_PROVIDER: "strands" },
    endpoint: "http://127.0.0.1:8000/v1/systemone", requestModel: undefined, responseModel: "strands-decider-2B-hobson-v19", key: undefined },
  { provider: "openai", env: { JEV_AUTO_MODE_PROVIDER: "openai", OPENAI_API_KEY: "openai-test-key" },
    endpoint: "https://api.openai.com/v1/decisions", requestModel: "gpt-6-luna", responseModel: "gpt-6-luna", key: "openai-test-key" },
] as const;

describe("provider selection", () => {
  it("keeps TypeSafe as the default, including env/stored key precedence and model selection", () => {
    const stored = describeDecisionAvailability({}, "stored-test-key");
    assert.deepEqual(stored, { available: true, provider: "typesafe", apiKey: "stored-test-key", model: "jev-latest", modelSource: "default", source: "stored secret (/jev-auto-mode login)" });
    const env = describeDecisionAvailability({ TYPESAFE_API_KEY: "env-test-key", TYPESAFE_DEFAULT_MODEL: "jev-test-version" }, "stored-test-key");
    assert.equal(env.available && env.apiKey, "env-test-key");
    assert.equal(env.model, "jev-test-version");
    assert.equal(env.source, "TYPESAFE_API_KEY");
    assert.equal(describeDecisionAvailability({ TYPESAFE_API_KEY: "k", JEV_AUTO_MODE_MODEL: "explicit-version" }).model, "explicit-version");
    assert.equal(describeDecisionAvailability({ PERPLEXITY_API_KEY: "k" }).available, false);
    assert.equal(DEFAULT_SETTINGS.uncertain, "allow");
  });

  it("follows jev-latest by default and lets a pinned release be overridden by the environment", () => {
    const key = { TYPESAFE_API_KEY: "k" };
    const pinned = { jevModel: "jev-1.13.0" };
    assert.equal(DEFAULT_SETTINGS.jevModel, undefined);
    assert.equal(describeDecisionAvailability(key, undefined, {}).model, "jev-latest");
    const fromSetting = describeDecisionAvailability(key, undefined, pinned);
    assert.equal(fromSetting.model, "jev-1.13.0");
    assert.equal(fromSetting.modelSource, "jevModel setting");
    const fromTypeSafeDefault = describeDecisionAvailability({ ...key, TYPESAFE_DEFAULT_MODEL: "jev-1.12.0" }, undefined, pinned);
    assert.deepEqual([fromTypeSafeDefault.model, fromTypeSafeDefault.modelSource], ["jev-1.12.0", "TYPESAFE_DEFAULT_MODEL"]);
    const explicit = describeDecisionAvailability({ ...key, TYPESAFE_DEFAULT_MODEL: "jev-1.12.0", JEV_AUTO_MODE_MODEL: "jev-1.11.0" }, undefined, pinned);
    assert.deepEqual([explicit.model, explicit.modelSource], ["jev-1.11.0", "JEV_AUTO_MODE_MODEL"]);
    // The Jev pin never leaks into another provider's model.
    assert.equal(describeDecisionAvailability({ JEV_AUTO_MODE_PROVIDER: "openai", OPENAI_API_KEY: "k" }, undefined, pinned).model, "gpt-6-luna");
  });

  it("accepts only well-formed jevModel values from settings files", () => {
    assert.deepEqual(parseSettingsPatch({ jevModel: "jev-1.13.0" }), { jevModel: "jev-1.13.0" });
    for (const jevModel of ["", " jev", "jev latest", "../jev", 42, null, "x".repeat(129)]) {
      assert.deepEqual(parseSettingsPatch({ jevModel }), {});
    }
  });

  it("does not read provider, endpoint, or credentials from project settings", () => {
    assert.deepEqual(parseSettingsPatch({ provider: "strands", endpoint: "http://untrusted", apiKey: "not-a-setting", JEV_AUTO_MODE_PROVIDER: "strands" }), {});
  });

  for (const fixture of providers) {
    it(`resolves only ${fixture.provider}'s credentials and endpoint`, () => {
      const availability = describeDecisionAvailability({
        TYPESAFE_API_KEY: "typesafe-only", OPENAI_API_KEY: "openai-only", PERPLEXITY_API_KEY: "perplexity-only",
        CLOUDFLARE_AUTH_TOKEN: "cloudflare-only", CLOUDFLARE_ACCOUNT_ID: accountId, ...fixture.env,
      }, "stored-typesafe");
      assert.equal(availability.available, true);
      assert.ok(availability.available && availability.provider !== "typesafe");
      assert.equal(availability.endpoint, fixture.endpoint);
      assert.equal(availability.apiKey, fixture.key);
    });
  }

  it("selects clef-flash in both the URL and request model", () => {
    const availability = describeDecisionAvailability({ ...cloudflareEnv, JEV_AUTO_MODE_MODEL: " clef-flash " });
    assert.ok(availability.available && availability.provider === "cloudflare");
    assert.equal(availability.model, "clef-flash");
    assert.equal(availability.endpoint, `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/cloudflare/clef-flash`);
  });

  it("does not silently fall back when configuration is missing or invalid", () => {
    for (const env of [
      { JEV_AUTO_MODE_PROVIDER: "perplexity" },
      { JEV_AUTO_MODE_PROVIDER: "cloudflare" },
      { ...cloudflareEnv, CLOUDFLARE_ACCOUNT_ID: "account/../attacker" },
      { ...cloudflareEnv, JEV_AUTO_MODE_MODEL: "llama" },
      { JEV_AUTO_MODE_PROVIDER: "strands", JEV_AUTO_MODE_MODEL: "jev-latest" },
      { JEV_AUTO_MODE_PROVIDER: "typo" },
      { JEV_AUTO_MODE_PROVIDER: "openai" },
    ]) {
      const availability = describeDecisionAvailability({ TYPESAFE_API_KEY: "must-not-fallback", ...env }, "stored-typesafe");
      assert.equal(availability.available, false);
      assert.equal(createEngine(DEFAULT_SETTINGS, { env: { TYPESAFE_API_KEY: "must-not-fallback", ...env } }).id, "manual");
    }
  });

  it("supports only loopback HTTP origins for Strands", () => {
    for (const [baseURL, expected] of [
      ["http://localhost:8099/", "http://127.0.0.1:8099/v1/systemone"],
      ["http://[::1]:8000", "http://[::1]:8000/v1/systemone"],
      ["http://127.0.0.1:8001", "http://127.0.0.1:8001/v1/systemone"],
    ]) {
      const availability = describeDecisionAvailability({ JEV_AUTO_MODE_PROVIDER: "strands", STRANDS_DECIDER_BASE_URL: baseURL });
      assert.ok(availability.available && availability.provider === "strands");
      assert.equal(availability.endpoint, expected);
    }
    for (const baseURL of [
      "https://localhost:8000", "http://192.168.1.1:8000", "http://example.com", "http://localhost.example.com",
      "http://127.0.0.1:8000/v1", "http://localhost:8000/?key=secret", "http://localhost/#fragment",
      "http://secret@localhost", "ftp://127.0.0.1", "not-a-url",
    ]) {
      assert.equal(describeDecisionAvailability({ JEV_AUTO_MODE_PROVIDER: "strands", STRANDS_DECIDER_BASE_URL: baseURL }).available, false);
    }
  });

  it("shows selected engines and unavailable providers without misreporting a TypeSafe key problem", () => {
    assert.equal(statusText({ enabled: true, engineId: "strands", scope: "global" }), "🛡 strands (global)");
    assert.equal(statusText({ enabled: true, engineId: "manual", provider: "openai", scope: "global" }), "🛡 openai unavailable (global)");
    assert.equal(statusText({ enabled: true, engineId: "manual", provider: "typesafe", scope: "global" }), "🛡 jev no key (global)");
  });
});

function context(options: { answer?: string; hasUI?: boolean; signal?: AbortSignal } = {}) {
  let prompts = 0;
  const ctx: GateContext = {
    cwd: "/tmp/decision-provider-tests", hasUI: options.hasUI ?? true, signal: options.signal,
    sessionManager: { getBranch: () => [
      { type: "message", message: { role: "user", content: "Run the requested operation." } },
      { type: "message", message: { role: "assistant", content: "DO_NOT_SEND_ASSISTANT" } },
      { type: "message", message: { role: "toolResult", content: "DO_NOT_SEND_TOOL_RESULT" } },
    ] },
    ui: {
      notify: () => {}, setStatus: () => {}, input: async () => undefined, editor: async () => undefined,
      confirm: async () => false,
      select: async () => { prompts++; return options.answer; },
    },
  };
  return { ctx, prompts: () => prompts };
}

let strandsTestPort = 21000;

for (const fixture of providers) {
  describe(`${fixture.provider} through the real gate`, () => {
    function setup(options: { probability?: number; malformed?: boolean; status?: number; uncertain?: UncertainAction; maxStateCharacters?: number } = {}) {
      const records: DecisionRecord[] = [];
      const requests: Array<Record<string, any>> = [];
      const settings = { ...DEFAULT_SETTINGS, maxRetries: 0, ...options };
      const endpoint = fixture.provider === "strands" ? `http://127.0.0.1:${strandsTestPort++}/v1/systemone` : fixture.endpoint;
      const engine = createEngine(settings, {
        env: { ...fixture.env, ...(fixture.provider === "strands" ? { STRANDS_DECIDER_BASE_URL: new URL(endpoint).origin } : {}), TYPESAFE_API_KEY: "must-not-use-typesafe" },
        fetch: async (url, init) => {
          assert.equal(url, endpoint);
          assert.equal(new Headers(init?.headers).get("authorization"), fixture.key ? `Bearer ${fixture.key}` : null);
          const body = JSON.parse(String(init?.body));
          assert.equal(body.model, fixture.requestModel);
          requests.push(body);
          const probability = options.probability ?? 0.99;
          const result = fixture.provider === "openai"
            ? {
                model: fixture.responseModel,
                answers: body.questions.map((question: { name: string }) => ({ type: "predicate", name: question.name, probability })),
                usage: { input_tokens: 100 },
              }
            : {
                model: fixture.responseModel,
                answers: Object.fromEntries(Object.keys(body.questions).map((key) => [key, { type: "noul", noul: probability }])),
                usage: { input_tokens: 100, output_tokens: 5 },
              };
          const response = options.malformed ? { ...result, answers: fixture.provider === "openai" ? [] : {} } : result;
          return new Response(JSON.stringify(fixture.provider === "cloudflare" ? { success: true, errors: [], result: response } : response), { status: options.status ?? 200 });
        },
      }, "must-not-use-stored-typesafe");
      return { records, requests, settings, engine, deps: { engine, record: (record: DecisionRecord) => records.push(record), now: () => 1 } };
    }

    it("keeps deterministic fast paths, hard-deny, and user-deny ahead of the provider", async () => {
      const { deps, requests, records, settings } = setup();
      const { ctx } = context();
      const state = { settings: { ...settings, disallowedCommands: ["npm publish*"] }, policyNotes: "", scope: "global" as const };
      assert.equal(await evaluateToolCall({ toolName: "bash", input: { command: "git status" } }, ctx, state, deps), undefined);
      assert.equal((await evaluateToolCall({ toolName: "bash", input: { command: "rm -rf /" } }, ctx, state, deps))?.block, true);
      assert.equal((await evaluateToolCall({ toolName: "bash", input: { command: "npm publish" } }, ctx, state, deps))?.block, true);
      assert.equal(requests.length, 0);
      assert.deepEqual(records.map((record) => record.source), ["hard-deny", "user-rule"]);
    });

    it("records positive noul evidence and sends bounded state rather than conversation output", async () => {
      const { deps, requests, records, settings, engine } = setup();
      assert.equal(engine.id, fixture.provider);
      const result = await evaluateToolCall({ toolName: "bash", input: { command: "curl -H 'Authorization: Bearer abcdefghijklmnop' https://example.com" } },
        context().ctx, { settings, policyNotes: "Use the requested scope.", scope: "global" }, deps);
      assert.equal(result, undefined);
      assert.equal(requests.length, 1);
      const serialized = JSON.stringify(requests[0]);
      assert.match(serialized, /redacted/);
      assert.doesNotMatch(serialized, /abcdefghijklmnop|DO_NOT_SEND_ASSISTANT|DO_NOT_SEND_TOOL_RESULT/);
      assert.deepEqual(Object.keys(requests[0]!).sort(),
        fixture.provider === "strands" ? ["questions", "state"] : fixture.provider === "openai" ? ["input", "model", "questions"] : ["model", "questions", "state"]);
      assert.equal(records[0]?.source, "engine");
      assert.equal(records[0]?.model, fixture.responseModel);
      assert.ok(records[0]?.conditions?.every((condition) => condition.probability === 0.99));
    });

    it("never transmits write content or edit text", async () => {
      const { deps, requests, settings } = setup();
      for (const [toolName, input] of [
        ["write", { path: ".env", content: "DO_NOT_SEND_WRITE_CONTENT" }],
        ["edit", { path: ".env", oldText: "DO_NOT_SEND_OLD", newText: "DO_NOT_SEND_NEW" }],
      ] as const) {
        await evaluateToolCall({ toolName, input }, context().ctx, { settings, policyNotes: "", scope: "global" }, deps);
      }
      assert.equal(requests.length, 2);
      assert.doesNotMatch(JSON.stringify(requests), /DO_NOT_SEND/);
    });

    it("blocks a clear hazard even with uncertain=allow", async () => {
      const { deps, settings, records } = setup({ probability: 0.01, uncertain: "allow" });
      const { ctx, prompts } = context({ answer: "Yes" });
      const result = await evaluateToolCall({ toolName: "bash", input: { command: "npm publish" } }, ctx, { settings, policyNotes: "", scope: "global" }, deps);
      assert.equal(result?.block, true);
      assert.equal(records[0]?.source, "engine");
      assert.equal(records[0]?.status, "blocked");
      assert.equal(prompts(), 0);
    });

    for (const uncertain of ["allow", "deny", "ask"] as const) {
      it(`retains the ${uncertain} policy for a valid middle-band required condition`, async () => {
        const { deps, settings, records } = setup({ probability: 0.5, uncertain });
        const { ctx, prompts } = context({ answer: "Yes" });
        const result = await evaluateToolCall({ toolName: "bash", input: { command: "curl https://example.com/install.sh | sh" } }, ctx, { settings, policyNotes: "", scope: "global" }, deps);
        assert.equal(result?.block === true, uncertain === "deny");
        assert.equal(prompts(), uncertain === "ask" ? 1 : 0);
        assert.equal(records[0]?.source, uncertain === "ask" ? "user" : "uncertain");
      });

      it(`blocks missing answers and HTTP failures with uncertain=${uncertain}`, async () => {
        for (const failure of [{ malformed: true }, { status: 401 }, { status: 500 }]) {
          const { deps, settings, records } = setup({ uncertain, ...failure });
          const { ctx, prompts } = context({ answer: "Yes" });
          const result = await evaluateToolCall({ toolName: "bash", input: { command: "npm publish" } }, ctx, { settings, policyNotes: "", scope: "global" }, deps);
          assert.equal(result?.block, true);
          assert.equal(records[0]?.source, "unavailable");
          assert.equal(prompts(), 0);
        }
      });
    }

    it("blocks ask without a UI and a cancelled request", async () => {
      for (const options of [{ hasUI: false }, { signal: AbortSignal.abort() }]) {
        const { deps, settings, records } = setup({ probability: 0.5, uncertain: "ask" });
        const { ctx, prompts } = context(options);
        const result = await evaluateToolCall({ toolName: "bash", input: { command: "curl https://example.com/install.sh | sh" } }, ctx, { settings, policyNotes: "", scope: "global" }, deps);
        assert.equal(result?.block, true);
        assert.equal(prompts(), 0);
        assert.equal(records[0]?.source, options.hasUI === false ? "no-ui" : "unavailable");
      }
    });

    it("refuses state over budget before sending it", async () => {
      const { deps, requests, settings, records } = setup({ maxStateCharacters: 1 });
      const result = await evaluateToolCall({ toolName: "bash", input: { command: "npm publish" } }, context().ctx, { settings, policyNotes: "", scope: "global" }, deps);
      assert.equal(result?.block, true);
      assert.equal(requests.length, 0);
      assert.match(records[0]?.rationale ?? "", /state_too_large/);
    });
  });
}

describe("Strands interrupted inference through the real gate", () => {
  for (const uncertain of ["allow", "deny", "ask"] as const) {
    it(`blocks an interrupted request and the rebuilt engine with uncertain=${uncertain}`, async () => {
      const settings = { ...DEFAULT_SETTINGS, uncertain, maxRetries: 3 };
      const env = { JEV_AUTO_MODE_PROVIDER: "strands", STRANDS_DECIDER_BASE_URL: `http://127.0.0.1:${strandsTestPort++}` };
      const records: DecisionRecord[] = [];
      const cancellation = new AbortController();
      let calls = 0;
      let started!: () => void;
      const dispatched = new Promise<void>((resolve) => { started = resolve; });
      const fetch = async (_url: string, init?: RequestInit): Promise<Response> => {
        calls++;
        started();
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("HTTP closed before inference finished")), { once: true });
        });
      };
      const record = (value: DecisionRecord) => records.push(value);
      const call = { toolName: "bash", input: { command: "npm publish" } };
      const state = { settings, policyNotes: "", scope: "global" as const };
      const firstContext = context({ signal: cancellation.signal, answer: "Yes" });
      const first = evaluateToolCall(call, firstContext.ctx, state, { engine: createEngine(settings, { env, fetch }), record, now: () => 1 });
      await dispatched;
      cancellation.abort();
      assert.equal((await first)?.block, true);
      const nextContext = context({ answer: "Yes" });
      const next = await evaluateToolCall(call, nextContext.ctx, state, { engine: createEngine(settings, { env, fetch }), record, now: () => 1 });
      assert.equal(next?.block, true);
      assert.match(next?.reason ?? "", /strands_completion_unknown/);
      assert.match(records[1]?.rationale ?? "", /Stop and restart.*Strands server, then restart Pi/);
      assert.ok(records.every((value) => value.source === "unavailable"));
      assert.equal(firstContext.prompts() + nextContext.prompts(), 0);
      assert.equal(calls, 1);
    });
  }
});

describe("missing provider configuration", () => {
  for (const uncertain of ["allow", "deny", "ask"] as const) {
    it(`blocks OpenAI without OPENAI_API_KEY before any HTTP call and without TypeSafe fallback, uncertain=${uncertain}`, async () => {
      let calls = 0;
      const records: DecisionRecord[] = [];
      const engine = createEngine(DEFAULT_SETTINGS, { env: { JEV_AUTO_MODE_PROVIDER: "openai", TYPESAFE_API_KEY: "no-fallback" },
        fetch: async () => { calls++; throw new Error("must not fetch"); } });
      const { ctx, prompts } = context({ answer: "Yes" });
      const result = await evaluateToolCall({ toolName: "bash", input: { command: "npm publish" } }, ctx,
        { settings: { ...DEFAULT_SETTINGS, uncertain }, policyNotes: "", scope: "global" },
        { engine, record: (record) => records.push(record), now: () => 1 });
      assert.equal(result?.block, true);
      assert.match(result.reason, /OPENAI_API_KEY/);
      assert.equal(records[0]?.source, "unavailable");
      assert.equal(calls, 0);
      assert.equal(prompts(), 0);
    });
  }
});

describe("Jev release selection through the real gate", () => {
  for (const [jevModel, expected] of [[undefined, "jev-latest"], ["jev-1.12.0", "jev-1.12.0"]] as const) {
    it(`sends ${expected} to TypeSafe when jevModel is ${jevModel ?? "unset"}`, async () => {
      const sent: Array<{ url: string; model: unknown }> = [];
      const settings = { ...DEFAULT_SETTINGS, maxRetries: 0, ...(jevModel === undefined ? {} : { jevModel }) };
      const engine = createEngine(settings, {
        env: { TYPESAFE_API_KEY: "typesafe-test-key" },
        fetch: async (url, init) => {
          const body = JSON.parse(String(init?.body));
          sent.push({ url: String(url), model: body.model });
          const answers = Object.fromEntries(Object.keys(body.questions).map((key) => [key, { type: "noul", noul: 0.99 }]));
          return new Response(JSON.stringify({ model: body.model, answers, usage: { input_tokens: 1, output_tokens: 1 } }),
            { headers: { "content-type": "application/json" } });
        },
      });
      const records: DecisionRecord[] = [];
      const result = await evaluateToolCall({ toolName: "bash", input: { command: "npm publish" } }, context().ctx,
        { settings, policyNotes: "", scope: "global" }, { engine, record: (record) => records.push(record), now: () => 1 });
      assert.equal(result, undefined);
      assert.deepEqual(sent.map((request) => request.model), [expected]);
      assert.match(sent[0]!.url, /\/v1\/systemone$/);
      assert.equal(records[0]?.model, expected);
    });
  }
});

describe("OpenAI refusals through the real gate", () => {
  for (const uncertain of ["allow", "deny", "ask"] as const) {
    it(`blocks a refused question with uncertain=${uncertain}`, async () => {
      const records: DecisionRecord[] = [];
      const settings = { ...DEFAULT_SETTINGS, maxRetries: 0, uncertain };
      const engine = createEngine(settings, {
        env: { JEV_AUTO_MODE_PROVIDER: "openai", OPENAI_API_KEY: "openai-test-key" },
        fetch: async (_url, init) => {
          const body = JSON.parse(String(init?.body));
          const answers = body.questions.map((question: { name: string }, index: number) =>
            index === 0 ? { type: "refusal", name: question.name } : { type: "predicate", name: question.name, probability: 0.99 });
          return new Response(JSON.stringify({ model: "gpt-6-luna", answers, usage: { input_tokens: 1 } }));
        },
      });
      const { ctx, prompts } = context({ answer: "Yes" });
      const result = await evaluateToolCall({ toolName: "bash", input: { command: "npm publish" } }, ctx,
        { settings, policyNotes: "", scope: "global" }, { engine, record: (record) => records.push(record), now: () => 1 });
      assert.equal(result?.block, true);
      assert.equal(records[0]?.source, "unavailable");
      assert.match(records[0]?.rationale ?? "", /refused/);
      assert.equal(prompts(), 0);
    });
  }
});
