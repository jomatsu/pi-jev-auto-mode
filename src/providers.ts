import { describeJevAvailability, describeKeySource } from "./jev/availability.ts";

export const DECISION_PROVIDERS = ["typesafe", "perplexity", "cloudflare", "strands", "openai"] as const;
export type DecisionProvider = (typeof DECISION_PROVIDERS)[number];
export type HttpDecisionProvider = "perplexity" | "cloudflare" | "strands" | "openai";

/** The TypeSafe alias that always resolves to the newest Jev release. */
export const JEV_LATEST_MODEL = "jev-latest";
export const OPENAI_DECISIONS_MODEL = "gpt-6-luna";

interface ProviderDescription {
  readonly model: string;
  /** Where the model choice came from, for status output. */
  readonly modelSource?: string;
  readonly source: string;
}

export interface DecisionAvailabilityOptions {
  /** `jevModel` from settings: a pinned Jev release, or undefined for `jev-latest`. */
  readonly jevModel?: string;
}

export type DecisionAvailability = ProviderDescription & (
  | { readonly available: false; readonly provider: string; readonly reason: string }
  | { readonly available: true; readonly provider: "typesafe"; readonly apiKey: string }
  | {
      readonly available: true;
      readonly provider: HttpDecisionProvider;
      readonly endpoint: string;
      readonly apiKey?: string;
    }
);

function unavailable(provider: string, reason: string): DecisionAvailability {
  return { available: false, provider, model: "unavailable", source: "none", reason };
}

/** Provider selection is process-local: a project settings file cannot redirect judgments. */
export function describeDecisionAvailability(
  env: NodeJS.ProcessEnv = process.env,
  storedTypeSafeKey?: string,
  options: DecisionAvailabilityOptions = {},
): DecisionAvailability {
  const provider = env.JEV_AUTO_MODE_PROVIDER?.trim() || "typesafe";
  const model = env.JEV_AUTO_MODE_MODEL?.trim();

  switch (provider) {
    case "typesafe": {
      const jev = describeJevAvailability(env, storedTypeSafeKey);
      if (!jev.available || !jev.apiKey) {
        return unavailable(provider, jev.reason ?? "no TypeSafe API key is available");
      }
      const typesafeDefault = env.TYPESAFE_DEFAULT_MODEL?.trim();
      const [selected, modelSource] = model
        ? [model, "JEV_AUTO_MODE_MODEL"]
        : typesafeDefault
          ? [typesafeDefault, "TYPESAFE_DEFAULT_MODEL"]
          : options.jevModel
            ? [options.jevModel, "jevModel setting"]
            : [JEV_LATEST_MODEL, "default"];
      return {
        available: true, provider, apiKey: jev.apiKey,
        model: selected, modelSource, source: describeKeySource(jev.source),
      };
    }
    case "perplexity": {
      const apiKey = env.PERPLEXITY_API_KEY?.trim();
      if (!apiKey) return unavailable(provider, "set PERPLEXITY_API_KEY to use Perplexity Decisions");
      return {
        available: true, provider, apiKey, source: "PERPLEXITY_API_KEY",
        model: model || "pplx-decider-v1-27b", endpoint: "https://api.perplexity.ai/v1/decisions",
      };
    }
    case "cloudflare": {
      const apiKey = env.CLOUDFLARE_AUTH_TOKEN?.trim();
      const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim();
      const selectedModel = model || "clef";
      if (selectedModel !== "clef" && selectedModel !== "clef-flash") {
        return unavailable(provider, "JEV_AUTO_MODE_MODEL must be clef or clef-flash for Cloudflare");
      }
      if (!apiKey || !accountId) {
        return unavailable(provider, "set CLOUDFLARE_AUTH_TOKEN and CLOUDFLARE_ACCOUNT_ID to use Clef");
      }
      if (!/^[a-fA-F0-9]{32}$/.test(accountId)) {
        return unavailable(provider, "CLOUDFLARE_ACCOUNT_ID must be a 32-character hexadecimal account ID");
      }
      return {
        available: true, provider, apiKey, source: "CLOUDFLARE_AUTH_TOKEN", model: selectedModel,
        endpoint: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/cloudflare/${selectedModel}`,
      };
    }
    case "strands": {
      if (model) {
        return unavailable(provider, "unset JEV_AUTO_MODE_MODEL for Strands; select the checkpoint when starting its server");
      }
      const endpoint = strandsEndpoint(env.STRANDS_DECIDER_BASE_URL?.trim() || "http://127.0.0.1:8000");
      if (!endpoint) {
        return unavailable(provider, "STRANDS_DECIDER_BASE_URL must be a loopback HTTP origin without credentials, path, query, or fragment");
      }
      return { available: true, provider, endpoint, model: "server checkpoint", source: "local server (no API key)" };
    }
    case "openai": {
      const apiKey = env.OPENAI_API_KEY?.trim();
      if (!apiKey) return unavailable(provider, "set OPENAI_API_KEY to use OpenAI Decisions");
      return {
        available: true, provider, apiKey, source: "OPENAI_API_KEY",
        model: model || OPENAI_DECISIONS_MODEL, endpoint: "https://api.openai.com/v1/decisions",
      };
    }
    default:
      return unavailable("unknown", `JEV_AUTO_MODE_PROVIDER must be one of ${DECISION_PROVIDERS.join(", ")}`);
  }
}

function strandsEndpoint(baseURL: string): string | undefined {
  try {
    const url = new URL(baseURL);
    if (url.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)) return undefined;
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return undefined;
    // Use a numeric loopback even when configured as localhost, avoiding DNS resolution.
    if (url.hostname === "localhost") url.hostname = "127.0.0.1";
    url.pathname = "/v1/systemone";
    return url.href;
  } catch {
    return undefined;
  }
}
