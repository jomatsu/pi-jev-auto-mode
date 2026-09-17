/**
 * Is the semantic layer usable right now?
 *
 * A missing key must not silently degrade into "allow everything": the engine
 * falls back to the ask-only engine, which confirms in a UI and blocks without
 * one. The reason is surfaced in `/jev-auto-mode status` so the degradation is
 * visible rather than mysterious.
 */

export interface JevAvailability {
  readonly available: boolean;
  readonly apiKey?: string;
  readonly model: string;
  readonly reason?: string;
}

export function describeJevAvailability(env: NodeJS.ProcessEnv = process.env): JevAvailability {
  const model = env.TYPESAFE_DEFAULT_MODEL?.trim() || "jev-latest";
  const apiKey = env.TYPESAFE_API_KEY?.trim();
  if (!apiKey) {
    return { available: false, model, reason: "TYPESAFE_API_KEY is not set" };
  }
  return { available: true, apiKey, model };
}
