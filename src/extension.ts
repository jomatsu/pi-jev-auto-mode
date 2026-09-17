/**
 * JEV auto mode for the Pi coding agent.
 *
 * The gate has two layers, and the order matters:
 *
 *   1. A deterministic policy layer (hard-deny, user rules, dangerous-pattern
 *      detection, protected paths). Hard-deny is not negotiable.
 *   2. A semantic layer (JEV) that only ever sees calls the deterministic layer
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
  describeJevAvailability,
  ruleById,
  type Observation,
  type ObservationMeta,
} from "./jev/index.ts";
import { extractRecentIntent } from "./intent.ts";
import {
  dangerousReasons,
  evaluateUserCommandRules,
  hardDenyReasons,
  isSafeCommand,
  PROTECTED_DIRECTORY_SEGMENTS,
  unique,
} from "./policy.ts";
import {
  createRecorder,
  registerDecisionEntryRenderer,
  type DecisionRecord,
  type DecisionRecorder,
} from "./records.ts";
import { DEFAULT_SETTINGS, JevAutoModeStore, parseThreshold, type JevAutoModeSettings, type SettingsScope } from "./settings.ts";
import {
  describeSettings,
  formatRuleTable,
  POLICY_HEADER,
  statusText,
  updateStatus,
  USAGE_TEXT,
  type ObservedCondition,
} from "./ui.ts";

export const AUTO_MODE_FLAG = "jev-auto-mode";
export const AUTO_MODE_COMMAND = "jev-auto-mode";

/** Structural context: what this extension needs from Pi, and nothing more. */
export interface GateUi {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  select(title: string, options: string[]): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
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
  return `JEV auto mode blocked this tool call. ${rationale} Do not repeat the same call unchanged; change the approach or ask the user.`;
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

  const call = buildGatedCall(event, { cwd: ctx.cwd });
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

    // Built-in read-only and verification commands run without a record.
    if (isSafeCommand(command)) return undefined;

    reasons = dangerousReasons(command, ctx.cwd);
    // Nothing dangerous matched: this is the fast path the gate exists to preserve.
    if (reasons.length === 0) return undefined;
  } else {
    const protectedReasons = unique(
      [call.protectedReason, call.outsideCwd ? "write outside the working directory" : undefined].filter(
        (reason): reason is string => typeof reason === "string",
      ),
    );
    if (protectedReasons.length === 0) return undefined;
    reasons = protectedReasons;
  }

  const input: CandidateInput = {
    call,
    reasons,
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
      if (!ctx.hasUI) {
        const rationale = `${verdict.rationale} No UI is available to confirm, so the call was blocked.`;
        return blocked(
          deps,
          { call, reasons, status: "blocked", source: "no-ui", rationale, evidence },
          blockReason(rationale),
        );
      }

      const dialog = [
        "JEV auto mode wants confirmation before this runs.",
        "",
        `Tool: ${call.tool}`,
        ...(call.command ? [call.command] : []),
        ...(call.path ? [call.path] : []),
        "",
        `Matched: ${reasons.join(", ")}`,
        `Rationale: ${verdict.rationale}`,
      ].join("\n");

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
        return { block: true, reason: "Blocked by the user at the JEV auto mode confirmation." };
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
 * Without an API key the gate keeps working with the ask-only engine rather than
 * dropping to "allow": the degradation stays visible and stays closed.
 */
export function createEngine(settings: JevAutoModeSettings, options: RegisterOptions = {}): DecisionEngine {
  if (options.engine) return options.engine;

  const availability = describeJevAvailability(options.env ?? process.env);
  if (!availability.available || !availability.apiKey) return createManualEngine();

  return createJevEngine({
    transport: createSdkTransport({
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
      for (const observation of observations) {
        observed.set(observation.ruleId, {
          probability: observation.probability,
          threshold: observation.threshold,
          verdict:
            observation.verdict === "uncertain" && observation.effective === "satisfied"
              ? "ignored"
              : observation.verdict,
          at: now(),
        });
      }
      options.onObservation?.(observations, meta);
    },
  };

  let deps: DecisionDeps = {
    engine: createEngine(state.settings, engineOptions),
    record: options.record ?? createRecorder(pi),
    now,
  };
  let loaded = false;

  const refresh = async (ctx: GateContext, applyFlag: boolean): Promise<void> => {
    const trusted = ctx.isProjectTrusted?.() ?? false;
    const loadedSettings = await store.loadSettings(ctx.cwd, trusted);
    state.settings = loadedSettings.settings;
    state.scope = loadedSettings.scope;
    state.policyNotes = await store.loadPolicyNotes();
    if (applyFlag && pi.getFlag(AUTO_MODE_FLAG) === true) {
      state.settings = { ...state.settings, enabled: true };
    }
    deps = { ...deps, engine: createEngine(state.settings, engineOptions) };
    loaded = true;
    updateStatus(ctx, { enabled: state.settings.enabled, engineId: deps.engine.id, scope: state.scope });
  };

  const save = async (ctx: GateContext): Promise<void> => {
    await store.saveSettings(state.settings, "global", ctx.cwd);
  };

  pi.registerFlag(AUTO_MODE_FLAG, {
    description: "Start with JEV auto mode enabled",
    type: "boolean",
    default: false,
  });

  registerDecisionEntryRenderer(pi);

  pi.registerCommand(AUTO_MODE_COMMAND, {
    description: "Show or change the JEV auto mode settings",
    getArgumentCompletions: (argumentPrefix) => {
      const value = String(argumentPrefix ?? "");
      const tokens = value.split(/\s+/).filter(Boolean);
      if (tokens.length === 0) {
        return ["status", "on", "off", "policy", "threshold"].map((item) => ({ value: item, label: item }));
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
      const availability = describeJevAvailability(options.env ?? process.env);
      const status = [
        statusText({
          enabled: state.settings.enabled,
          engineId: deps.engine.id,
          scope: state.scope,
        }),
        "",
        describeSettings(state.settings, state.scope),
        availability.available
          ? `semantic layer: ${availability.model}`
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
        ctx.ui.notify(`JEV auto mode ${value === "on" ? "enabled" : "disabled"}.`, "info");
        return;
      }

      if (value === "policy") {
        ctx.ui.notify(state.policyNotes.trim() || "(no policy notes configured)", "info");
        return;
      }

      if (value === "policy edit") {
        const edited = await ctx.ui.editor("JEV auto mode policy", state.policyNotes || POLICY_HEADER);
        if (edited === undefined) return;
        await store.savePolicyNotes(edited);
        state.policyNotes = await store.loadPolicyNotes();
        ctx.ui.notify("Policy notes saved.", "info");
        return;
      }

      if (value === "policy clear") {
        const confirmed = await ctx.ui.confirm(
          "Clear JEV auto mode policy notes?",
          "The semantic layer will fall back to its built-in criteria.",
        );
        if (!confirmed) return;
        await store.savePolicyNotes("");
        state.policyNotes = "";
        ctx.ui.notify("Policy notes cleared.", "info");
        return;
      }

      if (value === "threshold" || value === "threshold list") {
        ctx.ui.notify(formatRuleTable(DEFAULT_RULES, state.settings.thresholds, observed), "info");
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
          deps = { ...deps, engine: createEngine(state.settings, engineOptions) };
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
        deps = { ...deps, engine: createEngine(state.settings, engineOptions) };
        ctx.ui.notify(
          `\`${ruleId}\` now requires p >= ${threshold.toFixed(2)} (rejecting at p <= ${(1 - threshold).toFixed(2)}).\n\n${formatRuleTable(DEFAULT_RULES, state.settings.thresholds, observed)}`,
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
