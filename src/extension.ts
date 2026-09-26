/**
 * Jev auto mode for the Pi coding agent.
 *
 * The gate has two layers, and the order matters:
 *
 *   1. A deterministic policy layer (hard-deny, user rules, dangerous-pattern
 *      detection, protected paths). Hard-deny is not negotiable.
 *   2. A semantic layer (Jev) that only ever sees calls the deterministic layer
 *      decided to escalate, and whose "allow" can never resurrect a hard-denied
 *      call.
 *
 * Anything the semantic layer cannot decide — timeout, malformed response,
 * cancelled request, missing engine — blocks the call. Silence is never consent.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { buildGatedCall, type GatedCall, type RepoFacts, type ToolCallEventLike } from "./call.ts";
import { createManualEngine, type CandidateInput, type DecisionEngine, type EngineEvidence, type EngineVerdict } from "./decide.ts";
import {
  DEFAULT_RULES,
  createJevEngine,
  createSdkTransport,
  createOpenRouterTransport,
  describeJevAvailability,
  describeKeySource,
  formatThreshold,
  ruleById,
  verifyApiKey,
  verifyOpenRouterApiKey,
  type JevAvailability,
  type Observation,
  type ObservationMeta,
} from "./jev/index.ts";
import { extractRecentIntent } from "./intent.ts";
import {
  dangerousReasons,
  evaluateUserCommandRules,
  hardDenyReasons,
  isReadOnlyCommandChain,
  isUserDeclaredSafeCommand,
  PROTECTED_DIRECTORY_SEGMENTS,
  unique,
} from "./policy.ts";
import {
  createRecorder,
  registerDecisionEntryRenderer,
  type DecisionRecord,
  type DecisionRecorder,
} from "./records.ts";
import {
  DEFAULT_SETTINGS,
  JevAutoModeStore,
  isDisplayMode,
  isGateScope,
  isJevProvider,
  isUncertainAction,
  parseThreshold,
  type JevAutoModeSettings,
  type SettingsScope,
} from "./settings.ts";
import {
  buildConfirmationDialog,
  describeSettings,
  DISPLAY_EXPLANATION,
  GATE_SCOPE_EXPLANATION,
  UNCERTAIN_EXPLANATION,
  formatRuleTable,
  POLICY_HEADER,
  statusText,
  updateStatus,
  USAGE_TEXT,
  type ObservedCondition,
} from "./ui.ts";

export const AUTO_MODE_FLAG = "jev-auto-mode";
export const AUTO_MODE_COMMAND = "jev-auto-mode";

/** The escalation reason for a call no pattern describes, under `gateScope: "all"`. */
export const NOT_KNOWN_SAFE_REASON = "not on the known-safe list";

/** The engine used when no semantic layer is available. */
export const MANUAL_ENGINE_ID = "manual";

/** Shown (and used as the block reason) when the gate has no Jev connection. */
export const NO_ENGINE_MESSAGE =
  "Not connected to Jev (no API key is set for the selected provider). Run `/jev-auto-mode login` to set a key, or `/jev-auto-mode off` to stop auto mode.";

/** Structural context: what this extension needs from Pi, and nothing more. */
export interface GateUi {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  select(title: string, options: string[]): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  editor(title: string, prefill?: string): Promise<string | undefined>;
  setStatus(key: string, text: string | undefined): void;
}

export interface GateContext {
  readonly cwd: string;
  readonly hasUI: boolean;
  readonly mode?: string;
  readonly sessionManager: { getBranch?: () => readonly unknown[]; getEntries?: () => readonly unknown[] };
  readonly ui: GateUi;
  readonly signal?: AbortSignal;
  isProjectTrusted?(): boolean;
}

export interface DecisionDeps {
  readonly engine: DecisionEngine;
  readonly record: DecisionRecorder;
  readonly now: () => number;
}

export interface GateState {
  settings: JevAutoModeSettings;
  policyNotes: string;
  scope: SettingsScope;
}

export interface BlockResult {
  readonly block: true;
  readonly reason: string;
}

export function createInitialState(): GateState {
  return { settings: DEFAULT_SETTINGS, policyNotes: "", scope: "global" };
}

function conversationBranch(ctx: GateContext): readonly unknown[] {
  const sessionManager = ctx.sessionManager as {
    getBranch?: () => readonly unknown[];
    getEntries?: () => readonly unknown[];
  };
  const branch = sessionManager.getBranch?.() ?? sessionManager.getEntries?.() ?? [];
  return Array.isArray(branch) ? branch : [];
}

export function repoFacts(cwd: string, call?: GatedCall): RepoFacts {
  // The concrete protection that triggered escalation is listed alongside the
  // configured roots, so a question about protected locations can be answered
  // against the actual target rather than a generic path list.
  const protectedPaths = unique([
    ...PROTECTED_DIRECTORY_SEGMENTS,
    ...(call?.protectedReason ? [call.protectedReason] : []),
  ]);

  return {
    cwd,
    isGitRepository: existsSync(join(cwd, ".git")),
    protectedPaths,
  };
}

interface RecordInput {
  readonly call: GatedCall;
  readonly reasons: readonly string[];
  readonly status: DecisionRecord["status"];
  readonly source: DecisionRecord["source"];
  readonly rationale: string;
  readonly evidence?: EngineEvidence;
}

function writeRecord(deps: DecisionDeps, input: RecordInput): void {
  const record: DecisionRecord = {
    tool: input.call.tool,
    summary: input.call.summary,
    reasons: [...input.reasons],
    status: input.status,
    source: input.source,
    rationale: input.rationale,
    ...(input.evidence?.conditions ? { conditions: input.evidence.conditions } : {}),
    ...(input.evidence?.decidingRule ? { decidingRule: input.evidence.decidingRule } : {}),
    ...(input.evidence?.clearedByIntent ? { clearedByIntent: input.evidence.clearedByIntent } : {}),
    ...(input.evidence?.probabilities ? { probabilities: input.evidence.probabilities } : {}),
    ...(input.evidence?.model ? { model: input.evidence.model } : {}),
    ...(input.evidence?.latencyMs !== undefined ? { latencyMs: input.evidence.latencyMs } : {}),
    timestamp: deps.now(),
  };
  deps.record(record);
}

function blocked(deps: DecisionDeps, input: RecordInput, reason?: string): BlockResult {
  writeRecord(deps, input);
  return { block: true, reason: reason ?? input.rationale };
}

function permit(deps: DecisionDeps, input: RecordInput): undefined {
  writeRecord(deps, input);
  return undefined;
}

/** Wraps an engine rationale so the model gets an actionable reason, not a verdict. */
function blockReason(rationale: string): string {
  return `Jev auto mode blocked this tool call. ${rationale} Do not repeat the same call unchanged; change the approach or ask the user.`;
}

/**
 * Decide one tool call.
 *
 * Exported so the whole policy path can be tested without a Pi runtime.
 */
export async function evaluateToolCall(
  event: ToolCallEventLike,
  ctx: GateContext,
  state: GateState,
  deps: DecisionDeps,
): Promise<BlockResult | undefined> {
  if (!state.settings.enabled) return undefined;

  const call = buildGatedCall(event, {
    cwd: ctx.cwd,
    extraProtectedPaths: state.settings.extraProtectedPaths,
  });
  if (!call) return undefined;

  const ruleConfig = {
    allowedCommands: state.settings.allowedCommands,
    disallowedCommands: state.settings.disallowedCommands,
  };

  let reasons: string[];

  if (call.tool === "bash") {
    const command = typeof event.input.command === "string" ? event.input.command : "";

    const hardReasons = hardDenyReasons(command);
    if (hardReasons.length > 0) {
      const rationale = `Non-negotiable safety rule matched: ${hardReasons.join(", ")}.`;
      return blocked(deps, { call, reasons: hardReasons, status: "blocked", source: "hard-deny", rationale });
    }

    const userRule = evaluateUserCommandRules(command, ruleConfig);
    if (userRule?.decision === "deny") {
      const rationale = `A user disallowed command pattern matched: ${userRule.pattern}.`;
      return blocked(deps, { call, reasons: [userRule.pattern], status: "blocked", source: "user-rule", rationale });
    }
    if (userRule?.decision === "allow") {
      return permit(deps, {
        call,
        reasons: [],
        status: "allowed",
        source: "user-rule",
        rationale: `A user allow pattern matched: ${userRule.pattern}.`,
      });
    }

    // A command the user declared safe is theirs to declare: it runs silently, and
    // that declaration also outranks a dangerous-pattern match.
    if (isUserDeclaredSafeCommand(command, state.settings.safeCommands)) return undefined;

    // A dangerous pattern is a reason to judge, even when the command looks like
    // reading (`grep secret ~/.ssh/...`), so it comes before the read-only fast path.
    const matchedReasons = dangerousReasons(command, ctx.cwd);
    if (matchedReasons.length > 0) {
      reasons = matchedReasons;
    } else if (isReadOnlyCommandChain(command)) {
      return undefined;
    } else if (state.settings.gateScope === "matched") {
      return undefined;
    } else {
      reasons = [NOT_KNOWN_SAFE_REASON];
    }
  } else {
    const protectedReasons = unique(
      [call.protectedReason, call.outsideCwd ? "write outside the working directory" : undefined].filter(
        (reason): reason is string => typeof reason === "string",
      ),
    );
    if (protectedReasons.length === 0) return undefined;
    reasons = protectedReasons;
  }

  // Without a key there is nothing to judge with. Say so and stop, rather than
  // letting a call through unjudged or blocking it with an unexplained verdict.
  if (deps.engine.id === MANUAL_ENGINE_ID) {
    const rationale = NO_ENGINE_MESSAGE;
    writeRecord(deps, {
      call,
      reasons,
      status: "blocked",
      source: "unavailable",
      rationale,
    });
    return { block: true, reason: rationale };
  }

  const input: CandidateInput = {
    call,
    reasons,
    // "not on the known-safe list" is the scope's own label, not a recognised danger.
    flagged: reasons.some((reason) => reason !== NOT_KNOWN_SAFE_REASON),
    intent: extractRecentIntent(conversationBranch(ctx)),
    policy: state.policyNotes,
    repo: repoFacts(ctx.cwd, call),
  };

  let verdict: EngineVerdict;
  try {
    verdict = await deps.engine.judge(input, { signal: ctx.signal });
  } catch {
    // An engine that throws is an engine that cannot decide. Fail closed.
    verdict = {
      verdict: "unavailable",
      reason: "engine_error",
      rationale: "The decision engine threw an error.",
    };
  }

  if (ctx.signal?.aborted) {
    return blocked(deps, {
      call,
      reasons,
      status: "blocked",
      source: "unavailable",
      rationale: "The request was cancelled before a decision was reached.",
    });
  }

  const evidence: EngineEvidence = {
    ...(verdict.probabilities ? { probabilities: verdict.probabilities } : {}),
    ...(verdict.thresholds ? { thresholds: verdict.thresholds } : {}),
    ...(verdict.conditions ? { conditions: verdict.conditions } : {}),
    ...(verdict.decidingRule ? { decidingRule: verdict.decidingRule } : {}),
    ...(verdict.clearedByIntent ? { clearedByIntent: verdict.clearedByIntent } : {}),
    ...(verdict.model ? { model: verdict.model } : {}),
    ...(verdict.latencyMs !== undefined ? { latencyMs: verdict.latencyMs } : {}),
  };

  switch (verdict.verdict) {
    case "allow":
      return permit(deps, {
        call,
        reasons,
        status: "allowed",
        source: "engine",
        rationale: verdict.rationale,
        evidence,
      });

    case "deny":
      return blocked(
        deps,
        { call, reasons, status: "blocked", source: "engine", rationale: verdict.rationale, evidence },
        blockReason(verdict.rationale),
      );

    case "unavailable": {
      const rationale = `No decision was available (${verdict.reason}): ${verdict.rationale}`;
      return blocked(
        deps,
        { call, reasons, status: "blocked", source: "unavailable", rationale, evidence },
        blockReason(rationale),
      );
    }

    case "uncertain": {
      // The middle band is a policy decision, not a prompt by default. An auto mode
      // that stops to ask the user has handed the decision back to the human, and
      // the agent can always ask in conversation if it needs guidance.
      if (state.settings.uncertain === "deny") {
        const rationale = `No condition decided the call, and the uncertain band is resolved to a block. ${verdict.rationale}`;
        return blocked(deps, {
          call,
          reasons,
          status: "blocked",
          source: "uncertain",
          rationale,
          evidence,
        });
      }

      if (state.settings.uncertain === "allow") {
        return permit(deps, {
          call,
          reasons,
          status: "allowed",
          source: "uncertain",
          rationale: `No condition was violated and the uncertain band is configured to allow. ${verdict.rationale}`,
          evidence,
        });
      }

      if (!ctx.hasUI) {
        const rationale = `${verdict.rationale} No UI is available to confirm, so the call was blocked.`;
        return blocked(
          deps,
          { call, reasons, status: "blocked", source: "no-ui", rationale, evidence },
          blockReason(rationale),
        );
      }

      const dialog = buildConfirmationDialog({
        tool: call.tool,
        ...(call.command === undefined ? {} : { command: call.command }),
        ...(call.path === undefined ? {} : { path: call.path }),
        reasons,
        rationale: verdict.rationale,
      });

      const choice = await ctx.ui.select(dialog, ["No", "Yes"]);
      if (choice !== "Yes") {
        writeRecord(deps, {
          call,
          reasons,
          status: "cancelled",
          source: "user",
          rationale: "The user declined the confirmation.",
          evidence,
        });
        return { block: true, reason: "Blocked by the user at the Jev auto mode confirmation." };
      }

      return permit(deps, {
        call,
        reasons,
        status: "confirmed",
        source: "user",
        rationale: "The user confirmed the call.",
        evidence,
      });
    }
  }
}

/**
 * Pick a rule, then type a value.
 *
 * The direct form (`threshold <rule> <value>`) is faster once the rule ids are
 * known; this exists so tuning does not require remembering them.
 */
async function editThreshold(
  ctx: { ui: GateUi },
  state: GateState,
  observed: ReadonlyMap<string, ObservedCondition>,
  save: (ctx: GateContext) => Promise<void>,
  rebuild: () => Promise<void>,
): Promise<void> {
  const choices = DEFAULT_RULES.map((rule) => {
    const threshold = state.settings.thresholds[rule.id] ?? rule.threshold;
    const last = observed.get(rule.id);
    return `${rule.id}  (t=${threshold}${last ? `, last p=${last.probability.toFixed(2)}` : ""})`;
  });

  const picked = await ctx.ui.select("Which condition?", choices);
  if (picked === undefined) return;
  const ruleId = picked.split(" ")[0] ?? "";
  const rule = ruleById(ruleId);
  if (!rule) return;

  const current = state.settings.thresholds[ruleId] ?? rule.threshold;
  const entered = await ctx.ui.input(`${ruleId}: threshold (0.5-1.0, default ${rule.threshold})`, String(current));
  if (entered === undefined) return;

  const threshold = parseThreshold(Number(entered.trim()));
  if (threshold === undefined) {
    ctx.ui.notify(`A threshold must be greater than 0.5 and at most 1.0 (got \`${entered.trim()}\`).`, "error");
    return;
  }

  state.settings = { ...state.settings, thresholds: { ...state.settings.thresholds, [ruleId]: threshold } };
  await save(ctx as unknown as GateContext);
  await rebuild();
  ctx.ui.notify(`\`${ruleId}\` now requires p >= ${threshold}`, "info");
}

export interface RegisterOptions {
  /** Override the engine (tests, or a different judgment backend). */
  readonly engine?: DecisionEngine;
  readonly store?: JevAutoModeStore;
  readonly record?: DecisionRecorder;
  readonly now?: () => number;
  /** Transport override, mainly for tests. */
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  readonly env?: NodeJS.ProcessEnv;
  /** Calibration channel: every condition of every judgment. */
  readonly onObservation?: (observations: readonly Observation[], meta: ObservationMeta) => void;
}

/**
 * Build the semantic engine for the current settings.
 *
 * With no key the gate still runs its own rules, but a call nothing vouches for is
 * blocked with "Not connected to Jev" rather than judged. A missing key must not
 * turn into "allow everything".
 */
export function createEngine(
  settings: JevAutoModeSettings,
  options: RegisterOptions = {},
  storedApiKey?: string,
): DecisionEngine {
  if (options.engine) return options.engine;

  const availability = describeJevAvailability(options.env ?? process.env, storedApiKey, settings.provider);
  if (!availability.available || !availability.apiKey) return createManualEngine();

  return createJevEngine({
    transport: (settings.provider === "openrouter" ? createOpenRouterTransport : createSdkTransport)({
      apiKey: availability.apiKey,
      timeoutMs: settings.timeoutMs,
      maxRetries: settings.maxRetries,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    }),
    model: availability.model,
    maxStateCharacters: settings.maxStateCharacters,
    thresholds: settings.thresholds,
    ...(options.onObservation === undefined ? {} : { onObservation: options.onObservation }),
  });
}

export function register(pi: ExtensionAPI, options: RegisterOptions = {}): void {
  const store =
    options.store ?? new JevAutoModeStore({ agentDir: getAgentDir(), configDirName: CONFIG_DIR_NAME });
  const state = createInitialState();
  const observed = new Map<string, ObservedCondition>();
  const now = options.now ?? (() => Date.now());

  // Wrap the calibration channel so the tuning table can show what the model last
  // answered for each condition, even when the decision did not depend on it.
  const engineOptions: RegisterOptions = {
    ...options,
    onObservation: (observations, meta) => {
      const at = now();
      for (const observation of observations) {
        observed.set(observation.ruleId, { probability: observation.probability, at });
      }
      options.onObservation?.(observations, meta);
    },
  };

  let deps: DecisionDeps = {
    engine: createEngine(state.settings, engineOptions),
    record: options.record ?? createRecorder(pi),
    now,
  };
  let availability: JevAvailability = describeJevAvailability(options.env ?? process.env, undefined, state.settings.provider);
  let loaded = false;

  /** Rebuild the engine from the settings and the currently resolvable key. */
  const rebuildEngine = async (): Promise<void> => {
    const storedApiKey = await store.readStoredApiKey(state.settings.provider);
    availability = describeJevAvailability(options.env ?? process.env, storedApiKey, state.settings.provider);
    deps = { ...deps, engine: createEngine(state.settings, engineOptions, storedApiKey) };
  };

  const refresh = async (ctx: GateContext, applyFlag: boolean): Promise<void> => {
    const trusted = ctx.isProjectTrusted?.() ?? false;
    const loadedSettings = await store.loadSettings(ctx.cwd, trusted);
    state.settings = loadedSettings.settings;
    state.scope = loadedSettings.scope;
    state.policyNotes = await store.loadPolicyNotes();
    if (applyFlag && pi.getFlag(AUTO_MODE_FLAG) === true) {
      state.settings = { ...state.settings, enabled: true };
    }
    await rebuildEngine();
    loaded = true;
    updateStatus(ctx, { enabled: state.settings.enabled, engineId: deps.engine.id, scope: state.scope });
    if (state.settings.enabled && deps.engine.id === MANUAL_ENGINE_ID) {
      ctx.ui.notify(NO_ENGINE_MESSAGE, "warning");
    }
  };

  const save = async (ctx: GateContext): Promise<void> => {
    await store.saveSettings(state.settings, "global", ctx.cwd);
  };

  pi.registerFlag(AUTO_MODE_FLAG, {
    description: "Start with Jev auto mode enabled",
    type: "boolean",
    default: false,
  });

  registerDecisionEntryRenderer(pi, () => state.settings.display);

  pi.registerCommand(AUTO_MODE_COMMAND, {
    description: "Show or change the Jev auto mode settings",
    getArgumentCompletions: (argumentPrefix) => {
      const value = String(argumentPrefix ?? "");
      const tokens = value.split(/\s+/).filter(Boolean);
      if (tokens.length === 0) {
        return ["status", "on", "off", "provider", "policy", "threshold", "scope", "uncertain", "display", "login", "logout"].map((item) => ({
          value: item,
          label: item,
        }));
      }
      if (tokens[0] === "threshold") {
        if (tokens.length <= 1) {
          return ["reset", ...DEFAULT_RULES.map((rule) => rule.id)]
            .filter((item) => item.startsWith(tokens[1] ?? ""))
            .map((item) => ({ value: `threshold ${item}`, label: item }));
        }
        if (tokens.length === 2) {
          const rule = ruleById(tokens[1] ?? "");
          if (!rule) return null;
          return [
            { value: `threshold ${rule.id}`, label: `current: ${rule.threshold}` },
            { value: `threshold ${rule.id} reset`, label: "reset to the calibrated default" },
          ];
        }
      }
      return null;
    },
    handler: async (args, ctx) => {
      const gateContext = toGateContext(ctx);
      if (!loaded) await refresh(gateContext, true);

      const value = String(args ?? "").trim();
      const status = [
        statusText({
          enabled: state.settings.enabled,
          engineId: deps.engine.id,
          scope: state.scope,
        }),
        "",
        describeSettings(state.settings, state.scope),
        availability.available
          ? `semantic layer: ${availability.provider} / ${availability.model} (key from ${describeKeySource(availability.source, availability.provider)})`
          : `semantic layer: unavailable (${availability.reason ?? "unknown reason"})`,
      ].join("\n");

      if (value === "" || value === "status") {
        ctx.ui.notify(status, "info");
        return;
      }

      if (value === "on" || value === "off") {
        state.settings = { ...state.settings, enabled: value === "on" };
        await save(gateContext);
        updateStatus(gateContext, {
          enabled: state.settings.enabled,
          engineId: deps.engine.id,
          scope: state.scope,
        });
        ctx.ui.notify(`Jev auto mode ${value === "on" ? "enabled" : "disabled"}.`, "info");
        return;
      }

      if (value === "policy") {
        ctx.ui.notify(state.policyNotes.trim() || "(no policy notes configured)", "info");
        return;
      }

      if (value === "policy edit") {
        const edited = await ctx.ui.editor("Jev auto mode policy", state.policyNotes || POLICY_HEADER);
        if (edited === undefined) return;
        await store.savePolicyNotes(edited);
        state.policyNotes = await store.loadPolicyNotes();
        ctx.ui.notify("Policy notes saved.", "info");
        return;
      }

      if (value === "policy clear") {
        const confirmed = await ctx.ui.confirm(
          "Clear Jev auto mode policy notes?",
          "The semantic layer will fall back to its built-in criteria.",
        );
        if (!confirmed) return;
        await store.savePolicyNotes("");
        state.policyNotes = "";
        ctx.ui.notify("Policy notes cleared.", "info");
        return;
      }

      if (value === "provider" || value.startsWith("provider ")) {
        const provider = value.slice("provider".length).trim();
        if (provider === "") {
          ctx.ui.notify(`semantic provider: ${state.settings.provider} (typesafe | openrouter)`, "info");
          return;
        }
        if (!isJevProvider(provider)) {
          ctx.ui.notify("Expected provider typesafe or openrouter.", "error");
          return;
        }
        const nextSettings = { ...state.settings, provider };
        const storedApiKey = await store.readStoredApiKey(provider);
        const nextAvailability = describeJevAvailability(options.env ?? process.env, storedApiKey, provider);
        const nextEngine = createEngine(nextSettings, engineOptions, storedApiKey);
        // A trusted project override must not rewrite the global provider. Prepare
        // the engine before persisting so a failed switch leaves the gate unchanged.
        await store.saveProvider(provider, state.scope, gateContext.cwd);
        state.settings = nextSettings;
        availability = nextAvailability;
        deps = { ...deps, engine: nextEngine };
        updateStatus(gateContext, { enabled: state.settings.enabled, engineId: deps.engine.id, scope: state.scope });
        ctx.ui.notify(`Semantic provider: ${provider}. ${availability.available ? `Using ${availability.model} (${describeKeySource(availability.source, provider)}).` : availability.reason}`, "info");
        return;
      }

      if (value === "login") {
        const provider = state.settings.provider;
        const entered = await ctx.ui.input(`${provider === "openrouter" ? "OpenRouter" : "TypeSafe"} API key`, provider === "openrouter" ? "sk-or-..." : "apikey_...");
        const apiKey = entered?.trim();
        if (!apiKey) {
          ctx.ui.notify("Login cancelled: no key entered.", "info");
          return;
        }

        const verification = await (provider === "openrouter" ? verifyOpenRouterApiKey : verifyApiKey)({
          apiKey,
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        });
        if (!verification.ok && verification.reason === "invalid") {
          ctx.ui.notify("The API rejected that key, so nothing was saved. Check the key and try again.", "error");
          return;
        }
        if (!verification.ok) {
          ctx.ui.notify(
            `Could not reach the ${provider === "openrouter" ? "OpenRouter" : "TypeSafe"} API to verify the key, so nothing was saved. Check the connection and try again.`,
            "error",
          );
          return;
        }

        await store.writeStoredApiKey(apiKey, provider);
        await rebuildEngine();
        updateStatus(gateContext, {
          enabled: state.settings.enabled,
          engineId: deps.engine.id,
          scope: state.scope,
        });
        ctx.ui.notify(
          `API key verified and stored at ${store.credentialPath(provider)} (mode 600).\n\nSemantic layer: ${availability.provider} / ${availability.model} (key from ${describeKeySource(availability.source, availability.provider)})`,
          "info",
        );
        return;
      }

      if (value === "logout") {
        const provider = state.settings.provider;
        const storedApiKey = await store.readStoredApiKey(provider);
        if (!storedApiKey) {
          ctx.ui.notify("No stored API key to remove.", "info");
          return;
        }
        const confirmed = await ctx.ui.confirm(
          `Remove the stored ${provider === "openrouter" ? "OpenRouter" : "TypeSafe"} API key?`,
          availability.provider === provider && availability.source === "env"
            ? `It is not in use anyway: ${describeKeySource("env", provider)} takes precedence.`
            : "Without a key the gate blocks every call it cannot vouch for, and says why.",
        );
        if (!confirmed) return;

        await store.deleteStoredApiKey(provider);
        await rebuildEngine();
        updateStatus(gateContext, {
          enabled: state.settings.enabled,
          engineId: deps.engine.id,
          scope: state.scope,
        });
        ctx.ui.notify(
          availability.available
            ? `Stored key removed. Still using ${describeKeySource(availability.source, availability.provider)}.`
            : "Stored key removed. The gate will block calls it cannot vouch for until a key is set again.",
          "info",
        );
        return;
      }

      if (value === "threshold" || value === "threshold list") {        ctx.ui.notify(formatRuleTable(DEFAULT_RULES, state.settings.thresholds, observed), "info");
        return;
      }

      if (value === "threshold edit") {
        await editThreshold(ctx, state, observed, save, rebuildEngine);
        return;
      }

      if (value.startsWith("scope")) {
        const argument = value.slice("scope".length).trim();
        if (argument === "") {
          ctx.ui.notify(`gate scope: ${state.settings.gateScope}\n\n${GATE_SCOPE_EXPLANATION}`, "info");
          return;
        }
        if (!isGateScope(argument)) {
          ctx.ui.notify(`Expected one of all, matched.\n\n${GATE_SCOPE_EXPLANATION}`, "error");
          return;
        }

        state.settings = { ...state.settings, gateScope: argument };
        await save(gateContext);
        ctx.ui.notify(`gate scope now: ${argument}\n\n${GATE_SCOPE_EXPLANATION}`, "info");
        return;
      }

      if (value.startsWith("display")) {
        const argument = value.slice("display".length).trim();
        if (argument === "") {
          ctx.ui.notify(`display: ${state.settings.display}\n\n${DISPLAY_EXPLANATION}`, "info");
          return;
        }
        if (!isDisplayMode(argument)) {
          ctx.ui.notify(`Expected one of full, compact.\n\n${DISPLAY_EXPLANATION}`, "error");
          return;
        }

        state.settings = { ...state.settings, display: argument };
        await save(gateContext);
        ctx.ui.notify(`decision records now display as: ${argument}`, "info");
        return;
      }

      if (value.startsWith("uncertain")) {
        const argument = value.slice("uncertain".length).trim();
        if (argument === "") {
          ctx.ui.notify(`uncertain: ${state.settings.uncertain}\n\n${UNCERTAIN_EXPLANATION}`, "info");
          return;
        }
        if (!isUncertainAction(argument)) {
          ctx.ui.notify(`Expected one of deny, ask, allow.\n\n${UNCERTAIN_EXPLANATION}`, "error");
          return;
        }

        state.settings = { ...state.settings, uncertain: argument };
        await save(gateContext);
        ctx.ui.notify(`uncertain band now resolves to: ${argument}\n\n${UNCERTAIN_EXPLANATION}`, "info");
        return;
      }

      const thresholdMatch = /^threshold\s+(\S+)(?:\s+(\S+))?$/.exec(value);
      if (thresholdMatch) {
        const ruleId = thresholdMatch[1] ?? "";
        const argument = thresholdMatch[2];

        if (ruleId === "reset" || argument === "reset") {
          const target = ruleId === "reset" ? argument : ruleId;
          const thresholds = { ...state.settings.thresholds };
          if (target && target !== "reset") {
            if (!ruleById(target)) {
              ctx.ui.notify(`Unknown rule \`${target}\`.\n\n${formatRuleTable(DEFAULT_RULES, state.settings.thresholds, observed)}`, "warning");
              return;
            }
            delete thresholds[target];
          } else {
            for (const key of Object.keys(thresholds)) delete thresholds[key];
          }
          state.settings = { ...state.settings, thresholds };
          await save(gateContext);
          await rebuildEngine();
          ctx.ui.notify(
            `Threshold overrides cleared${target && target !== "reset" ? ` for \`${target}\`` : ""}.\n\n${formatRuleTable(DEFAULT_RULES, state.settings.thresholds, observed)}`,
            "info",
          );
          return;
        }

        const rule = ruleById(ruleId);
        if (!rule) {
          ctx.ui.notify(`Unknown rule \`${ruleId}\`.\n\n${formatRuleTable(DEFAULT_RULES, state.settings.thresholds, observed)}`, "warning");
          return;
        }

        if (argument === undefined) {
          ctx.ui.notify(formatRuleTable(DEFAULT_RULES, state.settings.thresholds, observed), "info");
          return;
        }

        const threshold = parseThreshold(Number(argument));
        if (threshold === undefined) {
          ctx.ui.notify(`A threshold must be greater than 0.5 and at most 1.0 (got \`${argument}\`).`, "error");
          return;
        }

        state.settings = {
          ...state.settings,
          thresholds: { ...state.settings.thresholds, [ruleId]: threshold },
        };
        await save(gateContext);
        await rebuildEngine();
        ctx.ui.notify(
          `\`${ruleId}\` now requires p >= ${formatThreshold(threshold)} (rejecting at p <= ${formatThreshold(1 - threshold)}).\n\n${formatRuleTable(DEFAULT_RULES, state.settings.thresholds, observed)}`,
          "info",
        );
        return;
      }

      ctx.ui.notify(USAGE_TEXT, "warning");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    await refresh(toGateContext(ctx), true);
  });

  pi.on("tool_call", async (event, ctx) => {
    const gateContext = toGateContext(ctx);
    if (!loaded) await refresh(gateContext, false);
    return evaluateToolCall(event as ToolCallEventLike, gateContext, state, deps);
  });
}

function toGateContext(ctx: ExtensionContext): GateContext {
  return {
    cwd: ctx.cwd,
    hasUI: ctx.hasUI,
    mode: ctx.mode,
    sessionManager: ctx.sessionManager,
    ui: ctx.ui,
    signal: ctx.signal,
    isProjectTrusted: () => ctx.isProjectTrusted(),
  };
}

export default function jevAutoMode(pi: ExtensionAPI): void {
  register(pi);
}
