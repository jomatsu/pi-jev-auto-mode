/**
 * The JEV transport contract.
 *
 * The interface is deliberately narrow and its result type is normalized: the
 * official SDK's exception hierarchy stops at `transport.ts`, so the engine and
 * the probability mapping stay pure and testable.
 *
 * `systemOne` only throws for caller cancellation. Every other failure comes back
 * as `{ ok: false }` carrying a reason code, because a gate must route failures
 * to a decision (block) rather than to an exception handler that might not exist.
 */

import type { JevJson } from "./state.ts";

/** Values accepted by `instructions` and `criteria`. */
export type JevEntry = string | { [key: string]: JevJson } | JevJson[] | null;

export interface JevNoulQuestion {
  readonly type: "noul";
  readonly instructions?: JevEntry;
  readonly criteria?: { readonly true?: JevEntry; readonly false?: JevEntry } | null;
}

export interface JevRequest {
  readonly state: { readonly value: JevJson; readonly context?: JevJson };
  readonly questions: Record<string, JevNoulQuestion>;
  readonly model?: string;
  readonly signal?: AbortSignal;
}

export type JevUnavailableReason =
  | "timeout"
  | "network"
  | "http"
  | "malformed_response"
  | "state_too_large"
  | "cancelled"
  | "unknown";

export type JevTransportResult =
  | { readonly ok: true; readonly response: unknown }
  | { readonly ok: false; readonly reason: JevUnavailableReason; readonly status?: number };

export interface JevTransport {
  systemOne(request: JevRequest): Promise<JevTransportResult>;
}
