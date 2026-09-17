/**
 * Is the semantic layer usable right now, and where did the key come from?
 *
 * A missing key must not silently degrade into "allow everything": the engine
 * falls back to the ask-only engine, which confirms in a UI and blocks without
 * one. The reason and the key's origin are surfaced in `/jev-auto-mode status` so
 * the degradation and the credential path are visible rather than mysterious.
 *
 * `TYPESAFE_API_KEY` wins over the stored secret, so a one-off or CI override does
 * not require touching the stored credential.
 */

export type JevKeySource = "env" | "stored" | "none";

export interface JevAvailability {
  readonly available: boolean;
  readonly apiKey?: string;
  readonly model: string;
  readonly source: JevKeySource;
  readonly reason?: string;
}

export function describeJevAvailability(
  env: NodeJS.ProcessEnv = process.env,
  storedApiKey?: string,
): JevAvailability {
  const model = env.TYPESAFE_DEFAULT_MODEL?.trim() || "jev-latest";

  const environmentKey = env.TYPESAFE_API_KEY?.trim();
  if (environmentKey) {
    return { available: true, apiKey: environmentKey, model, source: "env" };
  }

  const stored = storedApiKey?.trim();
  if (stored) {
    return { available: true, apiKey: stored, model, source: "stored" };
  }

  return {
    available: false,
    model,
    source: "none",
    reason: "no TypeSafe API key is available (run /jev-auto-mode login, or set TYPESAFE_API_KEY)",
  };
}

export function describeKeySource(source: JevKeySource): string {
  if (source === "env") return "TYPESAFE_API_KEY";
  if (source === "stored") return "stored secret (/jev-auto-mode login)";
  return "none";
}
