/**
 * Jev layer: transport, question set, response validation, and the engine.
 */

export { createJevEngine, DEFAULT_MAX_STATE_CHARACTERS, type JevEngineOptions, type ObservationMeta } from "./engine.ts";
export { describeJevAvailability, describeKeySource, type JevAvailability, type JevKeySource } from "./availability.ts";
export { createSdkTransport, isAbortError, verifyApiKey, type ApiKeyVerification, type SdkTransportOptions } from "./transport.ts";
export { DEFAULT_RULES, applyThresholdOverrides, buildQuestions, ruleById, rulesForTool, type JevRule, type JevRuleMode, type JevSeverity } from "./questions.ts";
export { DEFAULT_CRITERIA } from "./criteria.ts";
export { classifyCondition, combine, formatThreshold, observe, type CombinedDecision, type ConditionVerdict, type Observation } from "./decide.ts";
export { parseAnswers, type ParsedAnswers } from "./response.ts";
export type {
  JevEntry,
  JevNoulQuestion,
  JevRequest,
  JevTransport,
  JevTransportResult,
  JevUnavailableReason,
} from "./types.ts";
export type { JevJson, JevState } from "./state.ts";
