/** OpenRouter adapter for the official TypeSafe SDK. */
import { createSdkTransport } from "./transport.ts";
import type { SdkTransportOptions } from "./transport.ts";
import type { JevTransport } from "./types.ts";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api";
const AUTH_KEY_URL = "https://openrouter.ai/api/v1/auth/key";

export interface OpenRouterTransportOptions {
  readonly apiKey: string;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly fetch?: SdkTransportOptions["fetch"];
}

export type OpenRouterApiKeyVerification =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "invalid" | "unreachable" };

/**
 * Create an OpenRouter-backed TypeSafe transport. The SDK handles the
 * /v1/systemone protocol; OpenRouter maps bare Jev IDs and aliases.
 */
export function createOpenRouterTransport(options: OpenRouterTransportOptions): JevTransport {
  const sdkTransport = createSdkTransport({
    baseURL: OPENROUTER_BASE_URL,
    apiKey: options.apiKey,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  return sdkTransport;
}

/** Verify an OpenRouter key with its dedicated auth-key endpoint. */
export async function verifyOpenRouterApiKey(options: {
  readonly apiKey: string;
  readonly fetch?: SdkTransportOptions["fetch"];
  readonly timeoutMs?: number;
}): Promise<OpenRouterApiKeyVerification> {
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);

  try {
    const response = await fetcher(AUTH_KEY_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${options.apiKey}` },
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) return { ok: false, reason: "invalid" };
    if (!response.ok) return { ok: false, reason: "unreachable" };

    // A successful status alone is not proof that the response is a valid key
    // verification response. Require the documented data object.
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || !("data" in body)) {
      return { ok: false, reason: "unreachable" };
    }
    const data = (body as { data?: unknown }).data;
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      return { ok: false, reason: "unreachable" };
    }
    return { ok: true };
  } catch {
    // Timeouts, aborts and network failures mean the key could not be verified.
    return { ok: false, reason: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}
