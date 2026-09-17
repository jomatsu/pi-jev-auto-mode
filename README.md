# pi-jev-auto-mode

Auto mode for the [Pi coding agent](https://github.com/earendil-works/pi-mono) backed by
**JEV** (TypeSafe System One, a decision-only model). Pi has no built-in permission system,
so a gate either exists as an extension or it does not exist at all. This one judges
`bash`, `write`, and `edit` tool calls semantically and **fails closed** whenever a decision
cannot be made.

> **Milestone 1.** The deterministic safety layer, settings, command surface, and decision
> records are implemented and tested. The JEV engine lands in milestone 2. Until then an
> escalated call is confirmed in the UI, or blocked when there is no UI — which is
> deliberately the safe direction. See [`PLAN.md`](./PLAN.md).

## What it does

The gate has two layers, in this order:

1. **Deterministic policy** — hard-deny commands, your allow/deny patterns, dangerous-command
   detection, protected paths. Hard-deny is never handed to the semantic layer.
2. **Semantic judgment (JEV)** — only the calls the first layer escalated.

```
hard-deny              → block (never reaches JEV)
your deny pattern      → block
your allow pattern     → allow
safe read-only command  → run, no record
in-project write/edit   → run, no record
everything else         → JEV: allow · block · confirm · block-if-undecidable
```

`rm -rf build` inside the repository is recognized as a scoped local deletion. A write to
`.env`, `.git/`, `~/.ssh`, `.pi/`, `.github/workflows/`, or `AGENTS.md` is escalated even when
the path is inside the working directory.

## Install

```sh
pi install /absolute/path/to/pi-jev-auto-mode
# or, once published:
pi install npm:pi-jev-auto-mode
```

Try it without installing:

```sh
pi -e /absolute/path/to/pi-jev-auto-mode
```

## Usage

```
/jev-auto-mode            show status
/jev-auto-mode on|off     toggle auto mode
/jev-auto-mode policy     list the policy notes
/jev-auto-mode policy edit
/jev-auto-mode policy clear
```

```
pi --jev-auto-mode        start with auto mode enabled
```

The footer shows `🛡 jev <engine> (<scope>)` while the gate is active. Every decision is
recorded in the transcript as an expandable entry (expand it to see per-condition
probabilities once the JEV engine lands). Records use `pi.appendEntry`, so they never enter
the model's context: the model cannot argue with the gate using its own past rationales.

## Configuration

Global settings: `$PI_CODING_AGENT_DIR/jev-auto-mode.json` (default `~/.pi/agent/`).
Project override: `<cwd>/.pi/jev-auto-mode.json`, honored **only for a trusted project** —
an untrusted checkout must not be able to loosen the gate that is judging it.
Policy notes: `$PI_CODING_AGENT_DIR/jev-auto-mode-policy.md`.

```json
{
  "enabled": true,
  "timeoutMs": 4000,
  "maxRetries": 1,
  "allowedCommands": ["rm -rf build*"],
  "disallowedCommands": ["npm publish*"],
  "extraProtectedPaths": [],
  "maxStateCharacters": 120000
}
```

- Allow patterns never match a command containing shell control syntax (`;`, `&&`, `|`,
  redirection, substitution), so `ls*` cannot approve `ls && rm -rf /`.
- Malformed values are dropped rather than defaulted, so a broken project file cannot pin a
  value that overrides the global layer.
- The built-in safe-command list is not configurable: a settings file cannot widen the fast
  path. It contains read-only inspection (`git status`/`diff`/`log`/`show`/`branch`, `ls`,
  `pwd`, `rg`, `grep`) and local verification (`uv run pytest|ruff|mypy`). Anything that runs
  arbitrary package code (`npm run …`, `npx`, `uvx`) is escalated on purpose.

## What leaves the machine

An escalated call sends the following to TypeSafe's API (`api.typesafe.ai`):

- the tool name and the bash command text (truncated),
- for `write` / `edit`: the target **path** — never the file contents or the diff,
- the working directory, the matched policy reason names,
- recent **user** messages (bounded), and your policy notes.

Obvious credentials (`*_KEY=…`, `Bearer …`, JWTs, `sk-…`, `ghp_…`, PEM private keys) are
redacted on the way out. Assistant output, tool output, and file contents are never sent.
Details and the failure-mode table: [`docs/security.md`](./docs/security.md).

## Development

```sh
npm install
npm test          # node:test, no network
npm run typecheck
```

Layout:

| Path | Responsibility |
|---|---|
| `src/policy.ts` | hard-deny, user rules, dangerous patterns, protected paths, safe commands |
| `src/call.ts` | `tool_call` → judgment state (redaction, truncation, path classification) |
| `src/intent.ts` | recent user-authored intent only |
| `src/decide.ts` | the decision-engine seam (`DecisionEngine`) |
| `src/jev/` | JEV transport, question set, response validation, probability mapping (M2) |
| `src/settings.ts` | global/project settings and policy notes |
| `src/records.ts` | `appendEntry` records and their renderer |
| `src/ui.ts` | footer status and user-facing text |
| `src/extension.ts` | `tool_call` orchestration and command wiring |

## Acknowledgements

The deterministic pattern catalogue is adapted from
[`@nilskluewer/pi-auto-permission-gate`](https://github.com/nilskluewer/pi-auto-permission-gate)
(MIT), and the three-layer structure (fast paths → hard rules → classifier) follows the same
extension and Qwen Code's Auto Mode. The JEV design constraints (fail closed, two-sided
thresholds that keep the middle band meaningful, one request per judgment) come from
[`zod-jev`](https://github.com/jomatsu/zod-jev), which was written as a reference for how
JEV behaves; this package does not depend on it.

## License

MIT
