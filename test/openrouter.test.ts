import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createOpenRouterTransport, verifyOpenRouterApiKey } from "../src/jev/openrouter.ts";
import type { JevRequest } from "../src/jev/types.ts";

const request: JevRequest = {
  state: { value: { action: "test" } },
  questions: { allow: { type: "noul" } },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("OpenRouter TypeSafe transport", () => {
  it("delegates to the SDK endpoint and sends the requested bare model", async () => {
    let url = "";
    let init: RequestInit | undefined;
    const transport = createOpenRouterTransport({
      apiKey: "or-key",
      maxRetries: 0,
      fetch: async (input, options) => {
        url = input;
        init = options;
        return jsonResponse({ decision: true });
      },
    });

    const result = await transport.systemOne({ ...request, model: "jev-1.13" });
    assert.equal(url, "https://openrouter.ai/api/v1/systemone");
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer or-key");
    assert.equal(JSON.parse(String(init?.body)).model, "jev-1.13");
    assert.deepEqual(result, { ok: true, response: { decision: true } });
  });

  it("keeps explicitly namespaced models unchanged and lets OpenRouter map its bare latest alias", async () => {
    let body = "";
    const transport = createOpenRouterTransport({
      apiKey: "key",
      maxRetries: 0,
      fetch: async (_input, init) => {
        body = String(init?.body);
        return jsonResponse({ ok: true });
      },
    });
    await transport.systemOne({ ...request, model: "typesafe/jev-1.13" });
    assert.equal(JSON.parse(body).model, "typesafe/jev-1.13");
    await transport.systemOne({ ...request, model: "jev-latest" });
    assert.equal(JSON.parse(body).model, "jev-latest");
  });

  it("normalizes HTTP errors and malformed responses", async () => {
    const http = createOpenRouterTransport({ apiKey: "key", maxRetries: 0, fetch: async () => new Response("", { status: 429 }) });
    assert.deepEqual(await http.systemOne(request), { ok: false, reason: "http", status: 429 });
    const malformed = createOpenRouterTransport({ apiKey: "key", maxRetries: 0, fetch: async () => new Response("not json") });
    assert.deepEqual(await malformed.systemOne(request), { ok: true, response: "not json" });
  });

  it("returns timeout on SDK timeout and propagates caller abort", async () => {
    const slow = createOpenRouterTransport({
      apiKey: "key", timeoutMs: 5, maxRetries: 0,
      fetch: (_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      }),
    });
    assert.deepEqual(await slow.systemOne(request), { ok: false, reason: "timeout" });

    const controller = new AbortController();
    const aborted = createOpenRouterTransport({
      apiKey: "key", maxRetries: 0,
      fetch: (_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      }),
    });
    const pending = aborted.systemOne({ ...request, signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { name: "APIUserAbortError" });
  });
});

describe("verifyOpenRouterApiKey", () => {
  it("uses the current-key endpoint with bearer token and verifies valid data", async () => {
    let url = "";
    let init: RequestInit | undefined;
    const result = await verifyOpenRouterApiKey({
      apiKey: "or-key",
      fetch: async (input, options) => {
        url = input;
        init = options;
        return jsonResponse({ data: { label: "test", limit: null } });
      },
    });
    assert.equal(url, "https://openrouter.ai/api/v1/key");
    assert.equal(init?.method, "GET");
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer or-key");
    assert.deepEqual(result, { ok: true });
  });

  it("rejects unauthorized keys and unsuccessful/malformed successful responses", async () => {
    for (const status of [401, 403]) {
      assert.deepEqual(await verifyOpenRouterApiKey({ apiKey: "x", fetch: async () => new Response("", { status }) }), { ok: false, reason: "invalid" });
    }
    for (const response of [new Response("", { status: 500 }), jsonResponse({}), jsonResponse({ data: [] }), jsonResponse({ data: {} }), jsonResponse({ data: { label: "" } })]) {
      assert.deepEqual(await verifyOpenRouterApiKey({ apiKey: "x", fetch: async () => response }), { ok: false, reason: "unreachable" });
    }
  });

  it("treats a stalled check and fetch failures as unreachable", async () => {
    const stalled = verifyOpenRouterApiKey({
      apiKey: "x", timeoutMs: 5,
      fetch: (_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      }),
    });
    assert.deepEqual(await stalled, { ok: false, reason: "unreachable" });
    assert.deepEqual(await verifyOpenRouterApiKey({ apiKey: "x", fetch: async () => { throw new Error("offline"); } }), { ok: false, reason: "unreachable" });
  });
});
