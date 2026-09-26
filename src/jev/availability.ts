/**
 * Is the semantic layer usable right now, and where did the key come from?
 *
 * A missing key must not silently degrade into "allow everything". The gate keeps
 * running its own rules — read-only and user-declared safe commands pass, hard-deny
 * patterns are blocked — but a call nothing vouches for is blocked with "Not
 * connected to Jev" instead of being judged. The reason and the key's origin are
 * surfaced in `/jev-auto-mode status` so the situation is visible rather than
 * mysterious.
 *
 * `TYPESAFE_API_KEY` wins over the stored secret, so a one-off or CI override does
 * not require touching the stored credential.
 */

import type { JevProvider } from "../settings.ts";

export type JevKeySource = "env" | "stored" | "none";

export interface JevAvailability {
  readonly available: boolean;
  readonly provider: JevProvider;
  readonly apiKey?: string;
  readonly model: string;
  readonly source: JevKeySource;
  readonly reason?: string;
}

export function describeJevAvailability(
  env: NodeJS.ProcessEnv = process.env,
  storedApiKey?: string,
  provider: JevProvider = "typesafe",
): JevAvailability {
  const keyName = provider === "openrouter" ? "OPENROUTER_API_KEY" : "TYPESAFE_API_KEY";
  const model = (provider === "openrouter" ? env.OPENROUTER_DEFAULT_MODEL : env.TYPESAFE_DEFAULT_MODEL)?.trim()
    || (provider === "openrouter" ? "typesafe/jev-1.13" : "jev-latest");

  const environmentKey = env[keyName]?.trim();
  if (environmentKey) {
    return { available: true, provider, apiKey: environmentKey, model, source: "env" };
  }

  const stored = storedApiKey?.trim();
  if (stored) {
    return { available: true, provider, apiKey: stored, model, source: "stored" };
  }

  return {
    available: false,
    provider,
    model,
    source: "none",
    reason: `no ${provider === "openrouter" ? "OpenRouter" : "TypeSafe"} API key is available (run /jev-auto-mode login, or set ${keyName})`,
  };
}

export function describeKeySource(source: JevKeySource, provider: JevProvider = "typesafe"): string {
  if (source === "env") return provider === "openrouter" ? "OPENROUTER_API_KEY" : "TYPESAFE_API_KEY";
  if (source === "stored") return "stored secret (/jev-auto-mode login)";
  return "none";
}
