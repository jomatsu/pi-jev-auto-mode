import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHttpDecisionTransport, type HttpDecisionOptions } from "../src/decision-http.ts";
import type { JevRequest } from "../src/jev/types.ts";

const request: JevRequest = {
  state: { value: { command: "npm publish", user_intent: "publish this package" }, context: { policy: "" } },
  questions: { permitted: { type: "noul", instructions: "Was this requested?", criteria: { true: "Requested", false: "Unrequested" } } },
  model: "pplx-decider-v1-27b",
};
const answer = {
  model: "pplx-decider-v1-27b",
  answers: { permitted: { type: "noul", noul: 0.99 } },
  usage: { input_tokens: 100, output_tokens: 1 },
};

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
}

let strandsTestPort = 22000;

function transport(fetch: NonNullable<HttpDecisionOptions["fetch"]>, overrides: Partial<HttpDecisionOptions> = {}) {
  return createHttpDecisionTransport({
    provider: "perplexity", endpoint: overrides.provider === "strands" ? `http://127.0.0.1:${strandsTestPort++}/v1/systemone` : "https://api.perplexity.ai/v1/decisions",
    apiKey: "perplexity-test-key", timeoutMs: 1000, maxRetries: 0, fetch, ...overrides,
  });
}

describe("decision HTTP contracts", () => {
  it("sends the Perplexity contract without unknown fields or a trailing slash", async () => {
    const client = transport(async (url, init) => {
      assert.equal(url, "https://api.perplexity.ai/v1/decisions");
      assert.equal(init?.method, "POST");
      assert.equal(init.redirect, "error");
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer perplexity-test-key");
      assert.equal(new Headers(init.headers).get("content-type"), "application/json");
      assert.deepEqual(JSON.parse(String(init.body)), { state: request.state, questions: request.questions, model: request.model });
      return json(answer);
    });
    assert.deepEqual(await client.systemOne(request), { ok: true, response: answer });
  });

  it("unwraps a successful Cloudflare REST envelope", async () => {
    const client = transport(async (_url, init) => {
      assert.equal(init?.redirect, "error");
      return json({ result: answer, success: true, errors: [], messages: [] });
    }, { provider: "cloudflare" });
    assert.deepEqual(await client.systemOne(request), { ok: true, response: answer });
  });

  for (const [name, body] of Object.entries({
    "failed envelope": { result: answer, success: false, errors: [] },
    "errors despite success": { result: answer, success: true, errors: [{ code: 1 }] },
    "missing success": { result: answer, errors: [] },
    "missing errors": { result: answer, success: true },
    "wrong errors type": { result: answer, success: true, errors: null },
    "missing result": { success: true, errors: [] },
    "binding response on REST": answer,
  })) {
    it(`rejects Cloudflare ${name}`, async () => {
      assert.deepEqual(await transport(async () => json(body), { provider: "cloudflare" }).systemOne(request),
        { ok: false, reason: "malformed_response" });
    });
  }

  it("sends Strands only the state/questions and never an Authorization header", async () => {
    const client = transport(async (url, init) => {
      assert.equal(url, "http://127.0.0.1:8000/v1/systemone");
      assert.equal(new Headers(init?.headers).has("authorization"), false);
      assert.equal(init?.redirect, "error");
      assert.deepEqual(JSON.parse(String(init?.body)), { state: request.state, questions: request.questions });
      return json({ ...answer, model: "strands-decider-2B-hobson-v19" });
    }, { provider: "strands", endpoint: "http://127.0.0.1:8000/v1/systemone", apiKey: "must-not-send" });
    assert.equal((await client.systemOne(request)).ok, true);
  });

  it("accepts noul with no separate confidence, including exact zero and one", async () => {
    for (const probability of [0, 1]) {
      const body = { ...answer, answers: { permitted: { type: "noul", noul: probability } } };
      assert.equal((await transport(async () => json(body)).systemOne(request)).ok, true);
    }
  });

  const malformed = [
    null, "allowed", [], {}, { answers: [] }, { answers: {} },
    { answers: { other: { type: "noul", noul: 1 } } },
    { answers: { permitted: true } },
    { answers: { permitted: { noul: 1 } } },
    { answers: { permitted: { type: "unknown", noul: 1 } } },
    { answers: { permitted: { type: "choice", choice: "allow", confidence: 1, noul: 1 } } },
    { answers: { permitted: { type: "noul", confidence: 1 } } },
    ...["1", null, -0.1, 1.1, Number.NaN, Infinity].map((noul) => ({ answers: { permitted: { type: "noul", noul } } })),
  ];
  for (const [index, body] of malformed.entries()) {
    it(`fails closed for malformed answer ${index + 1} without retrying`, async () => {
      let calls = 0;
      const client = transport(async () => { calls++; return json(body); }, { maxRetries: 2 });
      assert.deepEqual(await client.systemOne(request), { ok: false, reason: "malformed_response" });
      assert.equal(calls, 1);
    });
  }

  it("rejects non-finite JSON numbers and non-JSON success bodies", async () => {
    for (const raw of ["", "<html>upstream error</html>", '{"answers":{"permitted":{"type":"noul","noul":1e309}}}']) {
      assert.deepEqual(await transport(async () => new Response(raw)).systemOne(request), { ok: false, reason: "malformed_response" });
    }
  });

  for (const [provider, limit] of [["cloudflare", 64], ["perplexity", 128]] as const) {
    it(`enforces ${provider}'s question limit before sending`, async () => {
      let calls = 0;
      const client = transport(async (_url, init) => {
        calls++;
        const body = JSON.parse(String(init?.body));
        const result = { answers: Object.fromEntries(Object.keys(body.questions).map((key) => [key, { type: "noul", noul: 1 }])) };
        return json(provider === "cloudflare" ? { success: true, errors: [], result } : result);
      }, { provider });
      const questions = Object.fromEntries(Array.from({ length: limit }, (_, index) => [`q${index}`, { type: "noul" as const, instructions: "Safe?" }]));
      assert.equal((await client.systemOne({ ...request, questions })).ok, true);
      assert.deepEqual(await client.systemOne({ ...request, questions: { ...questions, overflow: { type: "noul" } } }), { ok: false, reason: "state_too_large" });
      assert.deepEqual(await client.systemOne({ ...request, questions: {} }), { ok: false, reason: "state_too_large" });
      assert.equal(calls, 1);
    });
  }
});

describe("HTTP failures, timeouts, and cancellation", () => {
  for (const status of [301, 400, 401, 403, 404, 422]) {
    it(`does not retry ${status} or interpret its HTML body as an answer`, async () => {
      let calls = 0;
      const client = transport(async () => { calls++; return new Response("<html>error</html>", { status }); }, { maxRetries: 2 });
      assert.deepEqual(await client.systemOne(request), { ok: false, reason: "http", status });
      assert.equal(calls, 1);
    });
  }

  for (const status of [408, 429, 500, 503]) {
    it(`retries ${status} within the configured budget`, async () => {
      let calls = 0;
      const client = transport(async () => ++calls === 1 ? json({}, status, { "retry-after": "0" }) : json(answer), { maxRetries: 1 });
      assert.equal((await client.systemOne(request)).ok, true);
      assert.equal(calls, 2);
    });
  }

  it("returns a final HTTP failure after exhausting retries", async () => {
    let calls = 0;
    const client = transport(async () => { calls++; return new Response(null, { status: 429, headers: { "retry-after": "0" } }); }, { maxRetries: 2 });
    assert.deepEqual(await client.systemOne(request), { ok: false, reason: "http", status: 429 });
    assert.equal(calls, 3);
  });

  it("waits a positive Retry-After within the budget before retrying", async () => {
    const sent: number[] = [];
    const client = transport(async () => {
      sent.push(performance.now());
      return sent.length === 1 ? json({}, 429, { "retry-after": "0.08" }) : json(answer);
    }, { maxRetries: 1 });
    assert.equal((await client.systemOne(request)).ok, true);
    assert.equal(sent.length, 2);
    assert.ok(sent[1]! - sent[0]! >= 75, `retried after ${sent[1]! - sent[0]!}ms`);
  });

  for (const provider of ["perplexity", "cloudflare"] as const) {
    it(`retries ${provider} when the connection breaks while reading a 200 body`, async () => {
      const ok = provider === "cloudflare" ? { result: answer, success: true, errors: [] } : answer;
      const broken = () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{\"answers\":"));
          controller.error(new TypeError("terminated"));
        },
      }), { status: 200 });
      let calls = 0;
      const client = transport(async () => ++calls === 1 ? broken() : json(ok), { provider, maxRetries: 1 });
      assert.equal((await client.systemOne(request)).ok, true);
      assert.equal(calls, 2);
      assert.deepEqual(await transport(async () => broken(), { provider }).systemOne(request), { ok: false, reason: "network" });
    });
  }

  it("does not retry sooner than a Retry-After beyond the gate budget", async () => {
    for (const header of ["3600", new Date(Date.now() + 3_600_000).toUTCString()]) {
      let calls = 0;
      const client = transport(async () => { calls++; return json({}, 429, { "retry-after": header }); }, { maxRetries: 1 });
      assert.deepEqual(await client.systemOne(request), { ok: false, reason: "http", status: 429 });
      assert.equal(calls, 1);
    }
  });

  it("retries network errors without exposing the exception text", async () => {
    let calls = 0;
    const client = transport(async () => {
      if (++calls === 1) throw new Error("do not expose provider credentials");
      return json(answer);
    }, { maxRetries: 1 });
    assert.equal((await client.systemOne(request)).ok, true);
    assert.equal(calls, 2);
    assert.deepEqual(await transport(async () => { throw new Error("private details"); }).systemOne(request), { ok: false, reason: "network" });
  });

  it("times out a pending fetch", async () => {
    const client = transport((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }), { timeoutMs: 10 });
    assert.deepEqual(await client.systemOne(request), { ok: false, reason: "timeout" });
  });

  it("keeps the timeout active while reading the response body", async () => {
    const client = transport(async (_url, init) => new Response(new ReadableStream({
      start(controller) {
        init?.signal?.addEventListener("abort", () => controller.error(new Error("body aborted")), { once: true });
      },
    })), { timeoutMs: 10 });
    assert.deepEqual(await client.systemOne(request), { ok: false, reason: "timeout" });
  });

  it("does not send an already cancelled request", async () => {
    let calls = 0;
    const client = transport(async () => { calls++; return json(answer); });
    await assert.rejects(client.systemOne({ ...request, signal: AbortSignal.abort("custom reason") }), { name: "AbortError" });
    assert.equal(calls, 0);
  });

  it("propagates cancellation during fetch without retries", async () => {
    let calls = 0;
    const cancellation = new AbortController();
    const client = transport((_url, init) => new Promise((_resolve, reject) => {
      calls++;
      init?.signal?.addEventListener("abort", () => reject(new Error("custom reason")), { once: true });
      cancellation.abort(new Error("private abort reason"));
    }), { maxRetries: 2 });
    await assert.rejects(client.systemOne({ ...request, signal: cancellation.signal }), { name: "AbortError", message: "Decision cancelled" });
    assert.equal(calls, 1);
  });

  it("propagates cancellation during Retry-After", async () => {
    let calls = 0;
    const cancellation = new AbortController();
    const client = transport(async () => {
      calls++;
      setTimeout(() => cancellation.abort(), 5);
      return json({}, 429, { "retry-after": "0.1" });
    }, { maxRetries: 2 });
    await assert.rejects(client.systemOne({ ...request, signal: cancellation.signal }), { name: "AbortError" });
    assert.equal(calls, 1);
  });

  it("serializes Strands requests and skips a pre-cancelled request", async () => {
    let active = 0;
    let maximum = 0;
    let calls = 0;
    const client = transport(async () => {
      calls++;
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return json(answer);
    }, { provider: "strands" });
    const results = await Promise.allSettled([
      client.systemOne(request),
      client.systemOne({ ...request, signal: AbortSignal.abort() }),
      client.systemOne(request),
    ]);
    assert.deepEqual(results.map((result) => result.status), ["fulfilled", "rejected", "fulfilled"]);
    assert.equal(calls, 2);
    assert.equal(maximum, 1);
  });

  it("cancels a queued Strands request before its predecessor finishes without releasing the queue", async () => {
    let calls = 0;
    let release: () => void = () => {};
    const predecessor = new Promise<void>((resolve) => { release = resolve; });
    const client = transport(async () => {
      calls++;
      if (calls === 1) await predecessor;
      return json(answer);
    }, { provider: "strands" });
    const first = client.systemOne(request);
    await Promise.resolve();
    const cancellation = new AbortController();
    const cancelled = client.systemOne({ ...request, signal: cancellation.signal });
    const third = client.systemOne(request);
    cancellation.abort();
    try {
      // One microtask turn is enough to observe cancellation, with the predecessor held open.
      let rejected = false;
      const checked = assert.rejects(cancelled, { name: "AbortError" }).then(() => { rejected = true; });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(rejected, true);
      assert.equal(calls, 1);
      await checked;
    } finally {
      release();
      await Promise.all([first, third]);
    }
    assert.equal(calls, 2);
  });
});
