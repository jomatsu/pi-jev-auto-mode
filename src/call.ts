/**
 * Turn a Pi tool call into the shape JEV will judge.
 *
 * What leaves this module is what a third party (TypeSafe) gets to see, so the
 * boundary is explicit: the command text and the target path are sent, file
 * contents, diffs, and tool output are not. Obvious credentials are redacted on
 * the way out.
 */

import { classifyWriteTarget } from "./policy.ts";
import type { JevJson, JevState } from "./jev/state.ts";

export type GatedTool = "bash" | "write" | "edit";

export const GATED_TOOLS: readonly GatedTool[] = ["bash", "write", "edit"];

export interface ToolCallEventLike {
  readonly toolName: string;
  readonly toolCallId?: string;
  readonly input: Record<string, unknown>;
}

export interface GatedCall {
  readonly tool: GatedTool;
  /** One-line description used in records and dialogs. */
  readonly summary: string;
  /** bash: the command, truncated and redacted. Absent for file tools. */
  readonly command?: string;
  /** write/edit: absolute target path. */
  readonly path?: string;
  /** write/edit: target relative to the working directory, when inside it. */
  readonly relativePath?: string;
  readonly outsideCwd: boolean;
  readonly protectedReason?: string;
  /** write/edit: number of edit hunks. */
  readonly editCount?: number;
  /** write: content size in characters. The content itself is never sent. */
  readonly contentLength?: number;
}

export interface CallOptions {
  readonly cwd: string;
  readonly maxCommandLength?: number;
  /** Additional protected locations from settings. */
  readonly extraProtectedPaths?: readonly string[];
}

export const DEFAULT_MAX_COMMAND_LENGTH = 4000;

const SECRET_PATTERNS: readonly { readonly pattern: RegExp; readonly replacement: string }[] = [
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: "<redacted-private-key>",
  },
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, replacement: "<redacted-jwt>" },
  { pattern: /\b(?:sk|rk)-[A-Za-z0-9_-]{16,}\b/g, replacement: "<redacted-key>" },
  { pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, replacement: "<redacted-token>" },
  { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{12,}\b/g, replacement: "<redacted-aws-key>" },
  { pattern: /\bapikey_[A-Za-z0-9_-]{8,}\b/gi, replacement: "<redacted-typesafe-key>" },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/g, replacement: "Bearer <redacted>" },
  {
    pattern:
      /((?:api[_-]?key|secret|token|password|passwd|access[_-]?key|client[_-]?secret|auth[_-]?token)\s*[:=]\s*)(["']?)([^\s"';|&]{6,})/gi,
    replacement: "$1$2<redacted>",
  },
];

/** Replace obvious credentials so they are neither sent nor displayed. */
export function redactSecrets(text: string): string {
  let result = text;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

export function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Build the gate's view of a tool call.
 *
 * Returns `undefined` for tools this extension does not gate.
 */
export function buildGatedCall(event: ToolCallEventLike, options: CallOptions): GatedCall | undefined {
  const maxCommandLength = options.maxCommandLength ?? DEFAULT_MAX_COMMAND_LENGTH;

  if (event.toolName === "bash") {
    const rawCommand = asString(event.input.command) ?? "";
    const command = truncate(redactSecrets(rawCommand), maxCommandLength);
    const firstLine = rawCommand.split("\n")[0] ?? rawCommand;
    return {
      tool: "bash",
      summary: truncate(redactSecrets(firstLine.trim()), 200) || "(empty command)",
      command,
      outsideCwd: false,
    };
  }

  if (event.toolName === "write" || event.toolName === "edit") {
    const inputPath = asString(event.input.path) ?? "";
    const target = classifyWriteTarget(inputPath, options.cwd, options.extraProtectedPaths ?? []);
    const editCount = Array.isArray(event.input.edits) ? event.input.edits.length : undefined;
    const contentLength = asString(event.input.content)?.length;

    return {
      tool: event.toolName,
      summary: `${event.toolName} ${target.relativeToCwd ?? target.absolute}`,
      path: target.absolute,
      relativePath: target.relativeToCwd,
      outsideCwd: target.outsideCwd,
      protectedReason: target.protectedReason,
      editCount,
      contentLength,
    };
  }

  return undefined;
}

export interface RepoFacts {
  readonly cwd: string;
  readonly isGitRepository: boolean;
  readonly protectedPaths: readonly string[];
}

export interface JevStateInput {
  readonly call: GatedCall;
  readonly reasons: readonly string[];
  /** Recent user-authored text. Never assistant or tool output. */
  readonly intent: string;
  /** User-authored policy notes. */
  readonly policy: string;
  readonly repo: RepoFacts;
}

export const NO_POLICY_PLACEHOLDER = "(no user policy configured)";
export const NO_INTENT_PLACEHOLDER = "(no recent user message available)";

/**
 * Assemble the JEV request state.
 *
 * The user policy is `context` (session-scoped) so conditions can name it, and
 * the call plus the user intent are `value` (per-call).
 */
export function toJevState(input: JevStateInput): JevState {
  const { call } = input;

  const value: Record<string, JevJson> = {
    tool: call.tool,
    operation: call.summary,
    matched_policy_reasons: [...input.reasons],
    user_intent: input.intent.trim() || NO_INTENT_PLACEHOLDER,
  };

  if (call.command !== undefined) value.command = call.command;
  if (call.path !== undefined) {
    value.path = call.path;
    value.relative_path = call.relativePath ?? null;
    value.outside_working_directory = call.outsideCwd;
  }
  if (call.editCount !== undefined) value.edit_count = call.editCount;
  if (call.contentLength !== undefined) value.content_length = call.contentLength;

  const context: Record<string, JevJson> = {
    policy: input.policy.trim() || NO_POLICY_PLACEHOLDER,
    repository: {
      cwd: input.repo.cwd,
      is_git_repository: input.repo.isGitRepository,
      protected_paths: [...input.repo.protectedPaths],
    },
  };

  return { value, context };
}
