import { setTimeout as delay } from "node:timers/promises";
import { parseAnswers } from "./jev/response.ts";
import type { JevRequest, JevTransport, JevTransportResult } from "./jev/types.ts";
import type { HttpDecisionProvider } from "./providers.ts";

export interface HttpDecisionOptions {
  readonly provider: HttpDecisionProvider;
  readonly endpoint: string;
  readonly apiKey?: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

interface StrandsServerState {
  pending: Promise<unknown>;
  readonly halted: AbortController;
}

// Keep exclusion across engine rebuilds and extension module reloads in this runtime.
// There is deliberately no reset API: restarting Pi alone cannot stop old server work.
const STRANDS_SERVERS = Symbol.for("pi-jev-auto-mode.strands-servers");
const runtime = globalThis as typeof globalThis & { [STRANDS_SERVERS]?: Map<string, StrandsServerState> };
const strandsServers = runtime[STRANDS_SERVERS] ??= new Map<string, StrandsServerState>();
const STRANDS_HALTED = { ok: false, reason: "strands_completion_unknown" } as const;

function strandsServer(endpoint: string): StrandsServerState {
  const url = new URL(endpoint);
  // IPv4/IPv6 loopback names at one port may reach the same mutable model engine.
  const host = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ? "loopback" : url.hostname;
  const key = `${url.protocol}//${host}:${url.port || (url.protocol === "http:" ? "80" : "443")}`;
  let state = strandsServers.get(key);
  if (!state) {
    state = { pending: Promise.resolve(), halted: new AbortController() };
    strandsServers.set(key, state);
  }
  return state;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Only noul answers are used; choice/score confidence is not P(true). */
function normalizeResponse(body: unknown, provider: HttpDecisionProvider, keys: string[]): JevTransportResult {
  let response = body;
  if (provider === "cloudflare") {
    if (!isRecord(body) || body.success !== true || !Array.isArray(body.errors) || body.errors.length !== 0) {
      return { ok: false, reason: "malformed_response" };
    }
    response = body.result;
  }
  if (!isRecord(response) || !isRecord(response.answers)) return { ok: false, reason: "malformed_response" };
  for (const key of keys) {
    const answer = response.answers[key];
    if (!Object.hasOwn(response.answers, key) || !isRecord(answer) || answer.type !== "noul") {
      return { ok: false, reason: "malformed_response" };
    }
  }
  if (!parseAnswers(response, keys).ok) return { ok: false, reason: "malformed_response" };
  return { ok: true, response };
}

function retryDelay(response: Response | undefined, attempt: number): number {
  const retryAfter = response?.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return Math.min(250 * 2 ** attempt, 1000);
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException("Decision cancelled", "AbortError");
}

function cancellableResult<T>(result: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return result;
  return new Promise((resolve, reject) => {
    const cancel = () => reject(new DOMException("Decision cancelled", "AbortError"));
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    result.then(
      (value) => { signal.removeEventListener("abort", cancel); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", cancel); reject(error); },
    );
  });
}

function strandsResult(result: Promise<JevTransportResult>, halted: AbortSignal): Promise<JevTransportResult> {
  return new Promise((resolve, reject) => {
    const stop = () => resolve(STRANDS_HALTED);
    halted.addEventListener("abort", stop, { once: true });
    if (halted.aborted) stop();
    result.then(
      (value) => { halted.removeEventListener("abort", stop); resolve(value); },
      (error: unknown) => { halted.removeEventListener("abort", stop); reject(error); },
    );
  });
}

/** REST adapters share retry/cancellation handling, not provider response assumptions. */
export function createHttpDecisionTransport(options: HttpDecisionOptions): JevTransport {
  const fetcher = options.fetch ?? fetch;
  const strands = options.provider === "strands" ? strandsServer(options.endpoint) : undefined;

  async function send(request: JevRequest): Promise<JevTransportResult> {
    throwIfCancelled(request.signal);
    if (strands?.halted.signal.aborted) return STRANDS_HALTED;
    const keys = Object.keys(request.questions);
    const limit = options.provider === "cloudflare" ? 64 : options.provider === "perplexity" ? 128 : Infinity;
    if (keys.length === 0 || keys.length > limit) return { ok: false, reason: "state_too_large" };
    const body = JSON.stringify({
      state: request.state,
      questions: request.questions,
      ...(options.provider === "strands" || request.model === undefined ? {} : { model: request.model }),
    });

    for (let attempt = 0; ; attempt++) {
      throwIfCancelled(request.signal);
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), options.timeoutMs);
      const signal = request.signal ? AbortSignal.any([request.signal, timeout.signal]) : timeout.signal;
      let dispatched = false;
      let completed = false;
      const haltIfIncomplete = () => {
        if (dispatched && !completed) strands?.halted.abort();
      };
      if (strands) signal.addEventListener("abort", haltIfIncomplete, { once: true });
      let failure: JevTransportResult;
      let response: Response | undefined;
      let retryable = false;
      try {
        dispatched = true;
        response = await fetcher(options.endpoint, {
          method: "POST", redirect: "error", signal,
          headers: {
            "Content-Type": "application/json",
            ...(options.provider === "strands" || options.apiKey === undefined ? {} : { Authorization: `Bearer ${options.apiKey}` }),
          },
          body,
        });
        // Reading the complete body distinguishes a malformed finished response from
        // a broken connection. HTTP abort alone does not mean model inference stopped.
        let strandsBody = "";
        if (strands) {
          strandsBody = await response.text();
          completed = true;
          if (response.status === 408 || response.status >= 500) strands.halted.abort();
          if (strands.halted.signal.aborted) return STRANDS_HALTED;
        }
        throwIfCancelled(request.signal);
        if (timeout.signal.aborted) {
          failure = { ok: false, reason: "timeout" };
          retryable = true;
        } else if (!response.ok) {
          failure = { ok: false, reason: "http", status: response.status };
          retryable = response.status === 408 || response.status === 429 || response.status >= 500;
          if (!strands) await response.body?.cancel();
        } else {
          // A body read failure is a broken connection (outer catch: network/timeout, retryable);
          // only a completely received body that does not parse is a malformed answer.
          const text = strands ? strandsBody : await response.text();
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            return { ok: false, reason: "malformed_response" };
          }
          throwIfCancelled(request.signal);
          if (timeout.signal.aborted) {
            failure = { ok: false, reason: "timeout" };
            retryable = true;
          } else {
            return normalizeResponse(parsed, options.provider, keys);
          }
        }
      } catch {
        haltIfIncomplete();
        throwIfCancelled(request.signal);
        failure = { ok: false, reason: timeout.signal.aborted ? "timeout" : "network" };
        retryable = true;
      } finally {
        clearTimeout(timer);
        if (strands) signal.removeEventListener("abort", haltIfIncomplete);
      }
      // Never retry local inference: even a connection failure can leave server work alive.
      if (strands) return failure;
      if (!retryable || attempt >= options.maxRetries) return failure;
      const pause = retryDelay(response, attempt);
      // Do not ignore a long Retry-After or keep a tool gate sleeping indefinitely.
      if (pause > options.timeoutMs) return failure;
      try {
        await delay(pause, undefined, { signal: request.signal });
      } catch {
        throwIfCancelled(request.signal);
        return { ok: false, reason: "unknown" };
      }
    }
  }

  return {
    systemOne(request) {
      if (!strands) return send(request);
      if (request.signal?.aborted) return Promise.reject(new DOMException("Decision cancelled", "AbortError"));
      if (strands.halted.signal.aborted) return Promise.resolve(STRANDS_HALTED);
      const result = strands.pending.then(() => send(request));
      // Keep the underlying work in the queue even when the caller's result is interrupted.
      strands.pending = result.catch(() => undefined);
      return cancellableResult(strandsResult(result, strands.halted.signal), request.signal);
    },
  };
}
