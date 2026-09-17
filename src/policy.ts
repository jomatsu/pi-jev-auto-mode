/**
 * Deterministic policy layer.
 *
 * Everything in this module runs before JEV. Hard-deny rules are deliberate,
 * non-overridable, and must never be reachable by a probabilistic decision: they
 * are the floor that keeps a mis-calibrated semantic verdict from becoming an
 * approved `rm -rf /`.
 *
 * The command pattern catalogue is adapted from the MIT-licensed
 * `@nilskluewer/pi-auto-permission-gate` extension; see README "Acknowledgements".
 */

import { isAbsolute, relative, resolve, sep } from "node:path";

export interface CommandRuleConfig {
  /** Shell-style `*` / `?` patterns that auto-approve without asking JEV. */
  readonly allowedCommands: readonly string[];
  /** Shell-style patterns that block immediately, before JEV. */
  readonly disallowedCommands: readonly string[];
}

export interface UserRuleDecision {
  readonly decision: "allow" | "deny";
  readonly pattern: string;
  readonly source: "user-allow" | "user-disallow";
}

export interface CommandPattern {
  readonly name: string;
  readonly pattern: RegExp;
}

/**
 * Read-only inspection commands.
 *
 * These run without producing a decision record: they cannot change state outside
 * the working tree, so gating them would only add latency.
 *
 * The built-in list is deliberately stack-neutral and contains no command that
 * executes project code. A verification runner (`uv run pytest`, `npm run test`,
 * `cargo test`, `go test`, ...) executes arbitrary code from the repository, which
 * is exactly the category the gate exists to judge — so those belong in the user's
 * `safeCommands` setting, where the choice is explicit and local.
 */
export const SAFE_COMMANDS: readonly string[] = [
  "git status*",
  "git diff*",
  "git log*",
  "git show*",
  "git branch",
  "ls*",
  "pwd",
  "rg*",
  "grep*",
];

/**
 * Shell control syntax. An allow pattern that matches through `;`, `&&`, `|`,
 * redirection, or substitution would smuggle a second command past the gate, so
 * allow patterns are disabled for commands containing any of these.
 */
const SHELL_CONTROL_CHARACTERS = /[\r\n;&|<>$`()\\]/;
const PATH_GLOB_CHARACTERS = /[*?[\]{}]/;

const REGEX_SPECIAL_CHARACTERS = /[.*+?^${}()|[\]\\]/g;

function commandGlobToRegExp(pattern: string): RegExp {
  let source = "^";
  for (const character of pattern) {
    if (character === "*") {
      source += "[\\s\\S]*";
    } else if (character === "?") {
      source += "[\\s\\S]";
    } else {
      source += character.replace(REGEX_SPECIAL_CHARACTERS, "\\$&");
    }
  }
  return new RegExp(`${source}$`, "i");
}

export function matchesCommandPattern(command: string, pattern: string, allowShellControl: boolean): boolean {
  const normalizedPattern = pattern.trim();
  if (!normalizedPattern) return false;
  if (normalizedPattern.includes("\n") || normalizedPattern.includes("\r")) return false;
  if (!allowShellControl && SHELL_CONTROL_CHARACTERS.test(command)) return false;
  return commandGlobToRegExp(normalizedPattern).test(command.trim());
}

function matchesAnyCommandPattern(
  command: string,
  patterns: readonly string[],
  allowShellControl: boolean,
): string | undefined {
  return patterns.find((pattern) => matchesCommandPattern(command, pattern, allowShellControl));
}

/**
 * User rules, in precedence order: deny beats allow. Hard-deny rules are applied
 * separately and cannot be overridden by either list.
 */
export function evaluateUserCommandRules(
  command: string,
  config: CommandRuleConfig,
): UserRuleDecision | undefined {
  // Deny patterns may contain shell control syntax: the user is naming a command
  // to refuse, so a looser match is the safer failure direction.
  const deniedPattern = matchesAnyCommandPattern(command, config.disallowedCommands, true);
  if (deniedPattern) return { decision: "deny", pattern: deniedPattern, source: "user-disallow" };

  const allowedPattern = matchesAnyCommandPattern(command, config.allowedCommands, false);
  if (allowedPattern) return { decision: "allow", pattern: allowedPattern, source: "user-allow" };
  return undefined;
}

/** Commands that are considered dangerous and must therefore be judged. */
const DANGEROUS_PATTERNS: readonly CommandPattern[] = [
  // File deletion / destructive filesystem traversal
  {
    name: "recursive/forced rm",
    pattern: /\brm\b(?=[^\n;&|]*\s-(?:[^\s;&|]*[rR][^\s;&|]*[fF]?|[^\s;&|]*[fF][^\s;&|]*[rR])\b|[^\n;&|]*\s--recursive\b)/i,
  },
  { name: "remove Git metadata", pattern: /\brm\b[^\n;&|]*\s(?:\.git|\.git\/|['"]\.git['"])/i },
  { name: "find delete", pattern: /\bfind\b[^\n;&|]*\s-delete\b/i },
  { name: "xargs rm", pattern: /\bxargs\b[^\n;&|]*\brm\b/i },

  // Package execution and publishing can run third-party code or change remote state
  {
    name: "package execution or publish",
    pattern:
      /\b(?:npm|pnpm|yarn|bun|pip|pip3|uv|poetry|cargo|gem|go|brew|apt(?:-get)?|dnf|pacman)\b[^\n;&|]*\b(?:exec|run|dlx|publish)\b/i,
  },
  { name: "package runner", pattern: /\b(?:npx|pnpm\s+dlx|yarn\s+dlx|bunx|pipx|uvx)\b/i },

  // Privilege escalation / permission or ownership foot-guns
  { name: "sudo", pattern: /\bsudo\b/i },
  { name: "world-writable permissions", pattern: /\bchmod\b[^\n;&|]*\b777\b/i },
  { name: "recursive chmod/chown", pattern: /\b(?:chmod|chown)\b[^\n;&|]*\s(?:-R|--recursive)\b/i },

  // Disk / partition / filesystem destruction
  { name: "format filesystem", pattern: /\bmkfs(?:\.[a-z0-9_+-]+)?\b/i },
  { name: "wipe filesystem signatures", pattern: /\bwipefs\b/i },
  { name: "disk shred/wipe", pattern: /\b(?:shred|srm)\b/i },
  { name: "partition editor", pattern: /\b(?:fdisk|parted|gparted|sfdisk|cfdisk)\b/i },
  { name: "macOS disk erase", pattern: /\bdiskutil\b[^\n;&|]*\b(?:erase|partition|apfs\s+delete|apfs\s+erase)\b/i },
  { name: "dd writes to disk device", pattern: /\bdd\b[^\n;&|]*\bof=\/dev\//i },

  // Git working tree / repo / history destruction
  { name: "git reset hard", pattern: /\bgit\b[^\n;&|]*\breset\b[^\n;&|]*\s--hard\b/i },
  { name: "git clean forced", pattern: /\bgit\b[^\n;&|]*\bclean\b(?=[^\n;&|]*\s-[^\s;&|]*f)[^\n;&|]*/i },
  { name: "git force push", pattern: /\bgit\b[^\n;&|]*\bpush\b[^\n;&|]*\s--(?:force|force-with-lease|mirror)\b/i },
  { name: "git force push", pattern: /\bgit\b[^\n;&|]*\bpush\b[^\n;&|]*\s-[^\s;&|]*f[^\s;&|]*\b/i },
  { name: "git branch force-delete", pattern: /\bgit\b[^\n;&|]*\bbranch\b[^\n;&|]*\s-D\b/i },
  { name: "git tag delete", pattern: /\bgit\b[^\n;&|]*\btag\b[^\n;&|]*\s-d\b/i },
  { name: "git remove files", pattern: /\bgit\b[^\n;&|]*\brm\b/i },
  { name: "git checkout all files", pattern: /\bgit\b[^\n;&|]*\bcheckout\b[^\n;&|]*\s--\s+(?:\.|\*)\b/i },
  { name: "git restore all files", pattern: /\bgit\b[^\n;&|]*\brestore\b[^\n;&|]*(?:\s\.\b|\s:\/\b|\s--source\b)/i },
  { name: "git reflog expiry", pattern: /\bgit\b[^\n;&|]*\breflog\b[^\n;&|]*\bexpire\b/i },
  {
    name: "git aggressive prune/gc",
    pattern: /\bgit\b[^\n;&|]*\b(?:gc|prune)\b[^\n;&|]*(?:--prune=(?:now|all)|--expire\s+now|--expire=now)/i,
  },

  // Containers / volumes can destroy local databases and development state
  {
    name: "docker prune/remove volumes",
    pattern: /\bdocker\b[^\n;&|]*\b(?:system\s+prune|volume\s+(?:rm|prune)|container\s+prune|image\s+prune)\b/i,
  },
  {
    name: "docker compose remove volumes",
    pattern: /\bdocker\s+compose\b[^\n;&|]*\bdown\b[^\n;&|]*(?:\s-v\b|\s--volumes\b)/i,
  },

  // Running remote scripts gives the author of that script the current user's access
  {
    name: "downloaded script execution",
    pattern: /\b(?:curl|wget)\b[^\n;&|]*(?:\|\s*(?:sh|bash|zsh)\b|\b(?:sh|bash|zsh)\s*<\s*\()/i,
  },

  // Sending local data out. Missing this class entirely was a real hole: a request
  // that uploads a file matched nothing and ran with no judgment at all.
  {
    name: "network upload of local data",
    pattern:
      /\b(?:curl|wget)\b[^\n;&|]*(?:\s-d\s*@|\s--data(?:-binary|-raw|-urlencode)?\s*@|\s-T\s|\s--upload-file\b|\s-F\s[^\s;&|]*=@|\s--form\s[^\s;&|]*=@)/i,
  },
  { name: "file transfer to a remote host", pattern: /\b(?:scp|rsync|sftp)\b/i },
  { name: "raw network connection", pattern: /\b(?:nc|ncat|netcat|telnet)\b/i },

  // Reading credential material into the transcript. Reading has no side effect, but
  // a private key pasted into a conversation is a leak with a long half-life.
  {
    name: "reads a credential file",
    pattern:
      /\b(?:cat|bat|less|more|head|tail|xxd|base64|grep|rg)\b[^\n;&|]*(?:\.ssh\/|id_rsa|id_ed25519|id_ecdsa|\.aws\/|\.gnupg|\.npmrc|credentials|\.env\b(?!\.(?:example|sample|template)))/i,
  },
];

/**
 * Catastrophic targets. These are never handed to JEV: a look-alike approval
 * would be unsafe even when the surrounding conversation seems to ask for it.
 *
 * The list is deliberately small. Everything else belongs to the semantic layer,
 * where context and user intent can legitimately change the answer.
 */
const HARD_DENY_PATTERNS: readonly CommandPattern[] = [
  {
    name: "recursive delete of a system or home root",
    pattern:
      /\brm\b[^\n;&|]*(?:--recursive|-[^\s;&|]*[rR][^\s;&|]*)[^\n;&|]*\s+["']?(?:\/|~|\$HOME|\$\{HOME\}|\/(?:Users|home|root|System|Applications|Library|etc|usr|var|bin|sbin|opt|private|Volumes))(?:["']?(?:\s|$)|\/)/i,
  },
  {
    name: "unresolved recursive delete target",
    pattern:
      /\brm\b(?=[^\n;&|]*(?:--recursive|-[^\s;&|]*[rR][^\s;&|]*))(?=[^\n;&|]*(?:\$\(|\$\{|\$[A-Za-z_]|\$['"]|~[A-Za-z]|[`*?[\]{}]|\{[^}]*,))[^\n;&|]*/i,
  },
  { name: "filesystem format or signature wipe", pattern: /\b(?:mkfs(?:\.[a-z0-9_+-]+)?|wipefs)\b/i },
  { name: "disk device overwrite", pattern: /\bdd\b[^\n;&|]*\bof\s*=\s*["']?\/dev\//i },
  {
    name: "macOS disk erase or partition",
    pattern: /\bdiskutil\b[^\n;&|]*\b(?:erase|partition|apfs\s+delete|apfs\s+erase)\b/i,
  },
  {
    name: "forced push to a protected branch",
    pattern:
      /\bgit\b[^\n;&|]*\bpush\b[^\n;&|]*(?:--force(?:-with-lease)?|-[^\s;&|]*f[^\s;&|]*)\b[^\n;&|]*\b(?:main|master|production|prod)\b/i,
  },
  {
    name: "forced push to a protected branch",
    pattern:
      /\bgit\b[^\n;&|]*\bpush\b[^\n;&|]*\b(?:main|master|production|prod)\b[^\n;&|]*(?:--force(?:-with-lease)?|-[^\s;&|]*f[^\s;&|]*)\b/i,
  },
  {
    name: "unresolved forced push target",
    pattern:
      /\bgit\b(?=[^\n;&|]*\bpush\b)(?=[^\n;&|]*(?:--force(?:-with-lease)?|-[^\s;&|]*f[^\s;&|]*))(?=[^\n;&|]*(?:\$\(|\$\{|\$[A-Za-z_]|\$['"]|~[A-Za-z]|[`*?[\]{}]|\{[^}]*,))[^\n;&|]*/i,
  },
];

export function hardDenyReasons(command: string): string[] {
  return unique(HARD_DENY_PATTERNS.filter(({ pattern }) => pattern.test(command)).map(({ name }) => name));
}

const LOCAL_DELETION_REASONS = new Set(["recursive/forced rm", "find delete"]);

const FIND_NARROWING_PREDICATES = new Set([
  "-atime",
  "-ctime",
  "-empty",
  "-group",
  "-iname",
  "-ipath",
  "-iregex",
  "-links",
  "-maxdepth",
  "-mindepth",
  "-mtime",
  "-name",
  "-newer",
  "-newermt",
  "-path",
  "-perm",
  "-regex",
  "-size",
  "-type",
  "-user",
]);

function isSafeRelativeDeletionTarget(target: string, cwd: string, allowCurrentDirectory: boolean): boolean {
  if (!target) return false;
  if (target.startsWith("/") || target.startsWith("~") || target.startsWith("$")) return false;
  if (/^[A-Za-z]:[\\/]/.test(target)) return false;
  if (PATH_GLOB_CHARACTERS.test(target)) return false;

  const normalizedSegments = target.replace(/^\.\/+/, "").split(/[\\/]/);
  if (!allowCurrentDirectory && normalizedSegments.length === 1 && normalizedSegments[0] === "") return false;
  if (normalizedSegments.some((segment) => segment === ".." || segment === ".git")) return false;

  const projectRoot = resolve(cwd);
  const resolvedTarget = resolve(projectRoot, target);
  const relativeTarget = relative(projectRoot, resolvedTarget);
  return (
    Boolean(relativeTarget) &&
    relativeTarget !== ".." &&
    !relativeTarget.startsWith(`..${sep}`) &&
    !relativeTarget.startsWith(sep)
  );
}

function isScopedRmCommand(command: string, cwd: string): boolean {
  if (SHELL_CONTROL_CHARACTERS.test(command) || PATH_GLOB_CHARACTERS.test(command)) return false;
  const tokens = command.trim().split(/[ \t]+/).filter(Boolean);
  if (tokens.shift()?.toLowerCase() !== "rm") return false;

  let optionsEnded = false;
  const targets: string[] = [];
  for (const token of tokens) {
    if (!optionsEnded && token === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && token.startsWith("-")) continue;
    // An option after the first target means the command is not a simple deletion.
    if (token.startsWith("-")) return false;
    targets.push(token);
  }

  return targets.length > 0 && targets.every((target) => isSafeRelativeDeletionTarget(target, cwd, false));
}

function isScopedFindDeleteCommand(command: string, cwd: string): boolean {
  if (SHELL_CONTROL_CHARACTERS.test(command) || PATH_GLOB_CHARACTERS.test(command)) return false;
  const tokens = command.trim().split(/[ \t]+/).filter(Boolean);
  if (tokens.shift()?.toLowerCase() !== "find") return false;
  if (tokens.includes("-exec") || tokens.includes("-execdir")) return false;
  if (!tokens.includes("-delete")) return false;

  const expressionStart = tokens.findIndex(
    (token) => token.startsWith("-") || token === "!" || token === "(" || token === ")",
  );
  if (expressionStart <= 0) return false;

  const roots = tokens.slice(0, expressionStart);
  const hasNarrowingPredicate = tokens.some((token) => FIND_NARROWING_PREDICATES.has(token));
  return roots.length > 0 && roots.every((root) => isSafeRelativeDeletionTarget(root, cwd, hasNarrowingPredicate));
}

/** `rm -rf build` / `find build -type f -delete` under the working directory. */
export function isScopedLocalDeletionCommand(command: string, cwd: string): boolean {
  return isScopedRmCommand(command, cwd) || isScopedFindDeleteCommand(command, cwd);
}

export function isSafeCommand(command: string, extraPatterns: readonly string[] = []): boolean {
  return (
    matchesAnyCommandPattern(command, SAFE_COMMANDS, false) !== undefined ||
    matchesAnyCommandPattern(command, extraPatterns, false) !== undefined
  );
}

/**
 * Names of the dangerous patterns a bash command matches, i.e. the reasons this
 * call has to be judged instead of running straight through.
 *
 * Returns an empty array when the command is safe to run as far as this layer can
 * tell. That is the fast path: the default is to stay out of the way.
 */
export function dangerousReasons(command: string, cwd?: string): string[] {
  const reasons = unique(DANGEROUS_PATTERNS.filter(({ pattern }) => pattern.test(command)).map(({ name }) => name));
  if (cwd && isScopedLocalDeletionCommand(command, cwd)) {
    return reasons.filter((reason) => !LOCAL_DELETION_REASONS.has(reason));
  }
  return reasons;
}

/** Directories that hold credentials, agent configuration, or CI definitions. */
export const PROTECTED_DIRECTORY_SEGMENTS: readonly string[] = [
  ".git",
  ".ssh",
  ".aws",
  ".gnupg",
  ".husky",
  ".pi",
  ".claude",
  ".codex",
];

/** Path fragments that are security-relevant even outside the segments above. */
const PROTECTED_PATH_FRAGMENTS: readonly string[] = ["/.github/workflows/", "/.config/gh/"];

const PROTECTED_FILE_PATTERNS: readonly RegExp[] = [
  /^\.env(?:\..+)?$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^\.mcp\.json$/i,
  /^credentials(?:\.json)?$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i,
  /\.(?:pem|key|p12|pfx)$/i,
  /^\.(?:zshrc|bashrc|bash_profile|profile|zprofile|zlogin)$/i,
  // Agent instruction files are a prompt-injection surface: a write there can
  // change what the agent believes it has been told.
  /^AGENTS\.md$/i,
  /^CLAUDE\.md$/i,
];

function normalizeForMatching(absolutePath: string): string {
  return absolutePath.replace(/\\/g, "/");
}

/**
 * Classify a path against the protected locations.
 *
 * `extraProtectedPaths` comes from settings. An entry containing `/` is matched as a
 * path fragment; anything else is matched against the file name. Matching is
 * case-insensitive on the normalized path.
 */
export function protectedPathReason(
  absolutePath: string,
  extraProtectedPaths: readonly string[] = [],
): string | undefined {
  // Matching is case-insensitive, but the reported name keeps the original case:
  // the message is read by a person looking at their own path.
  const normalized = normalizeForMatching(absolutePath);
  const lowered = normalized.toLowerCase();
  const segments = normalized.split("/").filter(Boolean);
  const loweredSegments = lowered.split("/").filter(Boolean);
  const baseName = segments[segments.length - 1] ?? "";
  const loweredBaseName = loweredSegments[loweredSegments.length - 1] ?? "";

  const extraEntry = extraProtectedPaths
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .find((entry) => {
      const loweredEntry = entry.toLowerCase();
      return loweredEntry.includes("/") ? lowered.includes(loweredEntry) : loweredBaseName === loweredEntry;
    });
  if (extraEntry) return `configured protected path \`${extraEntry}\``;

  const segment = loweredSegments.find((part) => PROTECTED_DIRECTORY_SEGMENTS.includes(part));
  if (segment) return `protected directory \`${segment}\``;

  const fragment = PROTECTED_PATH_FRAGMENTS.find((part) => lowered.includes(part));
  if (fragment) return `protected path \`${fragment}\``;

  const filePattern = PROTECTED_FILE_PATTERNS.find((pattern) => pattern.test(baseName));
  if (filePattern) return `protected file \`${baseName}\``;

  return undefined;
}

export interface WriteTarget {
  readonly absolute: string;
  readonly relativeToCwd: string | undefined;
  readonly outsideCwd: boolean;
  readonly protectedReason: string | undefined;
}

/**
 * Classify a write/edit target lexically.
 *
 * A symlink inside the working directory can still point outside it; resolving
 * that needs a filesystem call and belongs to the JEV layer's state building.
 */
export function classifyWriteTarget(
  inputPath: string,
  cwd: string,
  extraProtectedPaths: readonly string[] = [],
): WriteTarget {
  const projectRoot = resolve(cwd);
  const absolute = resolve(projectRoot, inputPath);
  const relativeToCwd = relative(projectRoot, absolute);
  const outsideCwd = isAbsolute(relativeToCwd)
    ? true
    : relativeToCwd === ".." || relativeToCwd.startsWith(`..${sep}`) || relativeToCwd === "";

  return {
    absolute,
    relativeToCwd: outsideCwd ? undefined : relativeToCwd,
    outsideCwd,
    protectedReason: protectedPathReason(absolute, extraProtectedPaths),
  };
}

export function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
