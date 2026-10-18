import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createHttpDecisionTransport, type HttpDecisionOptions } from "../src/decision-http.ts";
import type { JevRequest } from "../src/jev/types.ts";

const request: JevRequest = {
  state: { value: { command: "npm publish" } },
  questions: { permitted: { type: "noul", instructions: "Was this requested?" } },
};
const answer = { answers: { permitted: { type: "noul", noul: 0.99 } } };
const halted = { ok: false, reason: "strands_completion_unknown" };
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

let port = 23000;
function endpoint() { return `http://127.0.0.1:${port++}/v1/systemone`; }
function options(url: string, fetch: NonNullable<HttpDecisionOptions["fetch"]>, timeoutMs = 1000): HttpDecisionOptions {
  return { provider: "strands", endpoint: url, timeoutMs, maxRetries: 3, fetch };
}

/**
 * HTTP cancellation leaves this server's work alive until finish() is called.
 * The counter deliberately follows model work, not the client fetch promise.
 */
function lingeringServer(mode: "fetch" | "body" | "network" | "ignore-abort") {
  const started = deferred<void>();
  const finished = deferred<void>();
  let calls = 0;
  let active = 0;
  let maximum = 0;
  const fetch: NonNullable<HttpDecisionOptions["fetch"]> = async (_url, init) => {
    calls++;
    active++;
    maximum = Math.max(maximum, active);
    started.resolve();
    const work = finished.promise.then(() => { active--; });
    if (mode === "network") throw new Error("connection lost after dispatch");
    if (mode === "ignore-abort") {
      await work;
      return new Response(JSON.stringify(answer));
    }
    if (mode === "body") {
      return new Response(new ReadableStream({
        start(controller) {
          let broken = false;
          const abort = () => { broken = true; controller.error(new Error("body interrupted")); };
          init?.signal?.addEventListener("abort", abort, { once: true });
          void work.then(() => {
            init?.signal?.removeEventListener("abort", abort);
            if (!broken) {
              controller.enqueue(new TextEncoder().encode(JSON.stringify(answer)));
              controller.close();
            }
          });
        },
      }));
    }
    return new Promise<Response>((resolve, reject) => {
      const abort = () => reject(new Error("client disconnected; inference is still running"));
      init?.signal?.addEventListener("abort", abort, { once: true });
      void work.then(() => {
        init?.signal?.removeEventListener("abort", abort);
        resolve(new Response(JSON.stringify(answer)));
      });
    });
  };
  return {
    fetch, started: started.promise, finish: () => finished.resolve(),
    counts: () => ({ calls, active, maximum }),
  };
}

describe("Strands inference exclusion", () => {
  for (const trigger of ["cancel", "timeout", "network"] as const) {
    for (const stage of trigger === "network" ? ["network"] as const : ["fetch", "body"] as const) {
      it(`halts ${trigger} during ${stage} while server work survives, including queued and rebuilt clients`, { timeout: 2000 }, async () => {
        const server = lingeringServer(stage);
        const url = endpoint();
        const config = options(url, server.fetch, trigger === "timeout" ? 300 : 1000);
        const firstClient = createHttpDecisionTransport(config);
        const otherClient = createHttpDecisionTransport(config);
        const cancellation = new AbortController();
        const first = firstClient.systemOne({ ...request, signal: cancellation.signal });
        const firstChecked = trigger === "cancel"
          ? assert.rejects(first, { name: "AbortError" })
          : first.then((result) => assert.deepEqual(result, halted));
        await server.started;
        const queued = firstClient.systemOne(request);
        const other = otherClient.systemOne(request);
        try {
          if (trigger === "cancel") cancellation.abort();
          await firstChecked;
          assert.deepEqual(await queued, halted);
          assert.deepEqual(await other, halted);
          assert.deepEqual(await createHttpDecisionTransport(config).systemOne(request), halted);
          // A late automatic retry must not overlap the still-running model.
          await delay(300);
          assert.deepEqual(server.counts(), { calls: 1, active: 1, maximum: 1 });
        } finally {
          server.finish();
          await turn();
        }
        // A late success is not an implicit reset of an indeterminate endpoint.
        assert.deepEqual(await otherClient.systemOne(request), halted);
        assert.deepEqual(server.counts(), { calls: 1, active: 0, maximum: 1 });
      });
    }
  }

  it("blocks waiting callers promptly even when the underlying fetch ignores abort", { timeout: 1000 }, async () => {
    const server = lingeringServer("ignore-abort");
    const url = endpoint();
    const client = createHttpDecisionTransport(options(url, server.fetch, 20));
    const first = client.systemOne(request);
    await server.started;
    const queued = client.systemOne(request);
    try {
      assert.deepEqual(await first, halted);
      assert.deepEqual(await queued, halted);
      assert.deepEqual(server.counts(), { calls: 1, active: 1, maximum: 1 });
    } finally {
      server.finish();
      await turn();
    }
    assert.deepEqual(await client.systemOne(request), halted);
    assert.equal(server.counts().calls, 1);
  });

  it("shares exclusion across adapters and loopback aliases until the full response body is read", async () => {
    const server = lingeringServer("body");
    const url = endpoint();
    const firstClient = createHttpDecisionTransport(options(url, server.fetch));
    const secondClient = createHttpDecisionTransport(options(url.replace("127.0.0.1", "localhost"), server.fetch));
    const thirdClient = createHttpDecisionTransport(options(url.replace("127.0.0.1", "[::1]"), server.fetch));
    const first = firstClient.systemOne(request);
    await server.started;
    const second = secondClient.systemOne(request);
    const third = thirdClient.systemOne(request);
    try {
      await turn();
      assert.deepEqual(server.counts(), { calls: 1, active: 1, maximum: 1 });
    } finally {
      server.finish();
    }
    assert.ok((await Promise.all([first, second, third])).every((result) => result.ok));
    assert.deepEqual(server.counts(), { calls: 3, active: 0, maximum: 1 });
  });

  it("keeps the stop across module reloads and aliases but isolates another server port", async () => {
    const url = endpoint();
    let calls = 0;
    const fetch = async () => { calls++; throw new Error("connection lost"); };
    assert.deepEqual(await createHttpDecisionTransport(options(url, fetch)).systemOne(request), halted);
    const reloaded: typeof import("../src/decision-http.ts") = await import(new URL("../src/decision-http.ts?strands-concurrency-reload", import.meta.url).href);
    for (const alias of ["127.0.0.1", "localhost", "[::1]"]) {
      const client = reloaded.createHttpDecisionTransport(options(url.replace("127.0.0.1", alias), fetch));
      assert.deepEqual(await client.systemOne(request), halted);
    }
    assert.equal(calls, 1);
    const independent = createHttpDecisionTransport(options(endpoint(), async () => {
      calls++;
      return new Response(JSON.stringify(answer));
    }));
    assert.equal((await independent.systemOne(request)).ok, true);
    assert.equal(calls, 2);
  });

  it("keeps exclusion with in-flight inference across a module reload", async () => {
    const server = lingeringServer("body");
    const url = endpoint();
    const first = createHttpDecisionTransport(options(url, server.fetch)).systemOne(request);
    await server.started;
    const reloaded: typeof import("../src/decision-http.ts") = await import(new URL("../src/decision-http.ts?strands-inflight-reload", import.meta.url).href);
    const second = reloaded.createHttpDecisionTransport(options(url.replace("127.0.0.1", "localhost"), server.fetch)).systemOne(request);
    try {
      await turn();
      assert.deepEqual(server.counts(), { calls: 1, active: 1, maximum: 1 });
    } finally {
      server.finish();
    }
    assert.ok((await Promise.all([first, second])).every((result) => result.ok));
    assert.deepEqual(server.counts(), { calls: 2, active: 0, maximum: 1 });
  });

  it("does not halt on invalid input or cancellation before dispatch", async () => {
    let calls = 0;
    const client = createHttpDecisionTransport(options(endpoint(), async () => {
      calls++;
      return new Response(JSON.stringify(answer));
    }));
    await assert.rejects(client.systemOne({ ...request, signal: AbortSignal.abort() }), { name: "AbortError" });
    assert.deepEqual(await client.systemOne({ ...request, questions: {} }), { ok: false, reason: "state_too_large" });
    assert.equal(calls, 0);
    assert.equal((await client.systemOne(request)).ok, true);
    assert.equal(calls, 1);
  });

  it("skips a cancelled queued request across adapters and continues after normal completion", async () => {
    const server = lingeringServer("body");
    const config = options(endpoint(), server.fetch);
    const firstClient = createHttpDecisionTransport(config);
    const secondClient = createHttpDecisionTransport(config);
    const first = firstClient.systemOne(request);
    await server.started;
    const cancellation = new AbortController();
    const cancelled = secondClient.systemOne({ ...request, signal: cancellation.signal });
    const checked = assert.rejects(cancelled, { name: "AbortError" });
    const last = firstClient.systemOne(request);
    try {
      cancellation.abort();
      await checked;
      assert.deepEqual(server.counts(), { calls: 1, active: 1, maximum: 1 });
    } finally {
      server.finish();
    }
    assert.ok((await Promise.all([first, last])).every((result) => result.ok));
    assert.deepEqual(server.counts(), { calls: 2, active: 0, maximum: 1 });
  });

  for (const status of [408, 500, 503, 504]) {
    it(`halts on ${status} with no retry or later request`, async () => {
      let calls = 0;
      const client = createHttpDecisionTransport(options(endpoint(), async () => {
        calls++;
        return new Response("server may still be working", { status, headers: { "retry-after": "0" } });
      }));
      assert.deepEqual(await client.systemOne(request), halted);
      assert.deepEqual(await client.systemOne(request), halted);
      assert.equal(calls, 1);
    });
  }

  for (const [name, body, status, expected] of [
    ["malformed JSON", "<html>finished</html>", 200, { ok: false, reason: "malformed_response" }],
    ["missing answers", "{}", 200, { ok: false, reason: "malformed_response" }],
    ["validation failure", "prompt too long", 422, { ok: false, reason: "http", status: 422 }],
    ["rate limit", "busy", 429, { ok: false, reason: "http", status: 429 }],
  ] as const) {
    it(`does not retry ${name} but permits a later request after the completed response`, async () => {
      let calls = 0;
      const client = createHttpDecisionTransport(options(endpoint(), async () => {
        calls++;
        return calls === 1 ? new Response(body, { status, headers: { "retry-after": "0" } }) : new Response(JSON.stringify(answer));
      }));
      assert.deepEqual(await client.systemOne(request), expected);
      assert.equal(calls, 1);
      assert.equal((await client.systemOne(request)).ok, true);
      assert.equal(calls, 2);
    });
  }
});
