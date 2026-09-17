/**
 * The official SDK, wrapped.
 *
 * Retries, timeouts, and the error taxonomy are the SDK's job; the only thing
 * added here is the translation into `JevTransportResult`, because the gate needs
 * failures to become decisions rather than exceptions.
 *
 * Caller cancellation is rethrown. Cancelling is control flow, not a verdict, and
 * the caller already knows how to record "cancelled before a decision".
 */

import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  TypeSafeClient,
} from "@typesafe-ai/sdk";
import type { JevRequest, JevTransport, JevTransportResult } from "./types.ts";

export interface SdkTransportOptions {
  readonly apiKey?: string;
  readonly baseURL?: string;
  readonly model?: string;
  /** Timeout per attempt. */
  readonly timeoutMs?: number;
  /** Retries after the first attempt. */
  readonly maxRetries?: number;
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof APIUserAbortError) return true;
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
}

function toFailure(error: unknown): JevTransportResult {
  if (error instanceof APITimeoutError) return { ok: false, reason: "timeout" };
  if (error instanceof APIConnectionError) return { ok: false, reason: "network" };
  if (error instanceof APIError) {
    // The SDK has already retried the transient statuses; anything that arrives
    // here is final. It becomes a block, never an approval.
    return { ok: false, reason: "http", status: error.status };
  }
  return { ok: false, reason: "unknown" };
}

/** The result of checking an API key against the API before storing it. */
export type ApiKeyVerification =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "invalid" | "unreachable" };

/**
 * Verify an API key by listing the models the account can use.
 *
 * Storing an unverified key would turn a typo into a gate that silently blocks every
 * escalated call, so the check happens before the key is written. A key is only
 * stored when the API accepted it; a network failure is reported as "try again",
 * never as "saved".
 */
export async function verifyApiKey(options: {
  readonly apiKey: string;
  readonly baseURL?: string;
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  readonly timeoutMs?: number;
}): Promise<ApiKeyVerification> {
  const client = new TypeSafeClient({
    apiKey: options.apiKey,
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    timeout: options.timeoutMs ?? 10_000,
    retry: { maxRetries: 0 },
  });

  try {
    await client.models.list();
    return { ok: true };
  } catch (error) {
    if (error instanceof APIError) {
      // 401 / 403 mean the key itself was refused; anything else is the API failing
      // to answer, which says nothing about the key.
      const status = error.status;
      return { ok: false, reason: status === 401 || status === 403 ? "invalid" : "unreachable" };
    }
    return { ok: false, reason: "unreachable" };
  }
}

export function createSdkTransport(options: SdkTransportOptions = {}): JevTransport {
  const client = new TypeSafeClient({
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    ...(options.model === undefined ? {} : { defaultModel: options.model }),
    ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
    ...(options.maxRetries === undefined ? {} : { retry: { maxRetries: options.maxRetries } }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });

  return {
    async systemOne(request: JevRequest): Promise<JevTransportResult> {
      try {
        const response = await client.systemOne(
          {
            state: request.state,
            questions: request.questions,
            ...(request.model === undefined ? {} : { model: request.model }),
          },
          request.signal === undefined ? undefined : { signal: request.signal },
        );
        return { ok: true, response };
      } catch (error) {
        if (isAbortError(error)) throw error;
        return toFailure(error);
      }
    },
  };
}
