# pi-jev-auto-mode

Auto mode for the [Pi coding agent](https://github.com/earendil-works/pi-mono) backed by
**Jev** (TypeSafe System One, a decision-only model). Pi has no built-in permission system,
so a gate either exists as an extension or it does not exist at all. This one judges
`bash`, `write`, and `edit` tool calls semantically and **fails closed** whenever a decision
cannot be made.

> **Status: milestones 1–3 are complete.** The deterministic envelope, the Jev engine,
> real-API calibration, settings, policy notes, per-rule threshold tuning, and decision
> records are implemented and tested (171 tests, no network). See [`docs/design.md`](./docs/design.md) for
> the roadmap and [`docs/calibration.md`](./docs/calibration.md) for the measured
> probabilities behind every threshold.

## What it does

The gate has two layers, in this order:

1. **Deterministic policy** — hard-deny commands, your allow/deny patterns, dangerous-command
   detection, protected paths. Hard-deny is never handed to the semantic layer.
2. **Semantic judgment (Jev)** — only the calls the first layer escalated.

```
hard-deny               → block (never reaches Jev)
your deny pattern       → block
your allow pattern      → allow (recorded)
your safeCommands       → run, no record
dangerous pattern match → Jev (even when the command looks read-only)
read-only builtin       → run, no record
in-project write/edit   → run, no record
everything else         → Jev: allow · block · block-if-undecidable
```

**`gateScope` decides how far the semantic layer reaches, and the default is `all`.** A denylist
can only recognise the shapes someone wrote a pattern for first: a command that uploaded a file
(`curl -d @~/.ssh/id_ed25519 ...`) matched nothing and ran with no judgment at all. Under `all`
the deterministic layer names what it can vouch for — read-only inspection, your declared safe
commands, a write inside the project to an unprotected path — and everything else is judged.
`matched` restores the old pattern-only behaviour. `/jev-auto-mode scope all|matched` changes it.

The trade is latency: a judged call costs roughly half a second (measured 193–642 ms across
eleven ordinary commands), while a fast-path call costs nothing. Read-only inspection is
therefore a real allowlist rather than a convenience.

An auto mode that stops for ordinary work has no reason to exist, so **the intent question is
asked only about commands the deterministic layer recognised as a dangerous shape, and only a
clear "this was not requested" blocks**. Measured: an unrequested `mv`, `cp`, `tar`, `chmod +x`,
or `node -e` is judged and allowed, while an unrequested `git reset --hard`, `npm publish`,
`rm -rf`, or `sudo` is blocked.

`rm -rf build` inside the repository is recognized as a scoped local deletion. A write to
`.env`, `.git/`, `~/.ssh`, `.pi/`, `.github/workflows/`, or `AGENTS.md` is escalated even when
the path is inside the working directory.

### How Jev decides

Conditions are phrased so the safe state is "yes", and each one is classified by
`mode` and `severity`:

| | meaning |
|---|---|
| `mode: required` | must be satisfied; the middle band escalates to a confirmation |
| `mode: hazard` | only a clear negative matters; the middle band is ignored |
| `severity: hazard` | a clear rejection always blocks |
| `severity: soft` | a clear rejection is cleared when the user's own request covers the call |

So `intent_coverage` ("is this what the user asked for?") is the permission question, and
questions like "is a secret being sent to a network endpoint" are hazard detectors that only
block when they are sure. Posting a private key is never cleared by intent; force-pushing a
feature branch the user asked for is.

**Nothing is delegated to the user by default.** The middle band — where Jev is neither
satisfied nor rejecting — resolves to a block, so Jev's probability is the whole answer and the
gate never takes over the screen. `/jev-auto-mode uncertain ask` restores the confirmation
dialog if you want it; `allow` trusts the band. Everything else that cannot be decided — no
engine, timeout, malformed response, cancellation — also blocks.

## Install

```sh
pi install npm:pi-jev-auto-mode
```

Or straight from the repository, which needs no npm account:

```sh
pi install git:github.com/jomatsu/pi-jev-auto-mode
```

Try it without installing:

```sh
pi -e npm:pi-jev-auto-mode
```

Packages are discovered in the [package gallery](https://pi.dev/packages) through the
`pi-package` keyword.

## Usage

```
/jev-auto-mode            show status (settings + where the API key comes from)
/jev-auto-mode on|off     toggle auto mode
/jev-auto-mode login      store a TypeSafe API key (verified, then saved 0600)
/jev-auto-mode logout     remove the stored key
/jev-auto-mode policy     list the policy notes
/jev-auto-mode policy edit
/jev-auto-mode policy clear
/jev-auto-mode threshold                show thresholds and the last observed probability per rule
/jev-auto-mode threshold <rule> <0.5-1> set one threshold
/jev-auto-mode threshold edit            pick a rule and type a value
/jev-auto-mode threshold reset [rule]   restore the calibrated default
/jev-auto-mode uncertain                show what the middle band resolves to
/jev-auto-mode uncertain deny|ask|allow
/jev-auto-mode scope all|matched        how far the semantic layer reaches
```

```
pi --jev-auto-mode        start with auto mode enabled
```

The semantic layer needs a [TypeSafe](https://typesafe.ai/) API key. Jev is early access, so an
account may be waitlisted; **the gate still works without one**, running in ask-only mode
(confirm in a UI, block without one) rather than silently allowing everything.

`/jev-auto-mode login` asks for the key, verifies it against the API (`GET /v1/models`), and
stores it as an owner-only file at
`$PI_CODING_AGENT_DIR/secrets/jev-auto-mode-typesafe-api-key` (mode `0600`) — the same place Pi
keeps its own credentials, so it is never committed with a project. `TYPESAFE_API_KEY` takes
precedence when set, so a one-off or CI override needs no login. `TYPESAFE_DEFAULT_MODEL`
selects the model (default `jev-latest`).

A key is only stored after the API accepts it: a typo that got saved would turn into a gate
that silently blocks every escalated call. If the API cannot be reached the key is not stored
either, and the command says so rather than claiming success.

Without a key the gate does not disable itself: it falls back to the ask-only engine, which
confirms in a UI and blocks when there is none. The footer shows `🛡 jev (<scope>)` while the
semantic layer is active and `🛡 jev ask-only (<scope>)` when it is not.

## Tuning

The thresholds are a starting point measured on twelve fixtures, not a truth
([`docs/calibration.md`](./docs/calibration.md)). To retune them from your own work:

1. Run the thing you care about. The gate records every judgment; expand the record in the
transcript and read the per-condition table:

```
intent_coverage     p=0.97  pass (t=0.80, >= 0.80)
no_outward_effect   p=0.06  reject (t=0.90, <= 0.10) <- decided (cleared by the user's request)
local_scope         p=0.81  pass (t=0.90, >= 0.90)
```

2. If a condition that should have passed lands in the middle band, lower its threshold. If
something got through that should not have, raise it. `/jev-auto-mode threshold` shows the
current value next to the last probability the model returned for that rule.

3. `/jev-auto-mode threshold <rule> <value>` writes the override. It takes effect immediately
and persists in the global settings file.

A threshold must leave a middle band on both sides (`0.5 < t <= 1`): `t` is the probability
required to count as satisfied, and `1 - t` is the probability at or below which the condition
counts as violated. Values that close one side are rejected.

```json
{
  "thresholds": {
    "intent_coverage": 0.6,
    "no_secret_egress": 0.995
  }
}
```

The right fix is usually to phrase the condition better, not to move the threshold. If "should
pass" and "should reject" answers overlap, the question is ambiguous.

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
  "safeCommands": ["uv run pytest*", "pnpm run typecheck*"],
  "allowedCommands": ["rm -rf build*"],
  "disallowedCommands": ["npm publish*"],
  "extraProtectedPaths": [],
  "maxStateCharacters": 120000,
  "uncertain": "deny",
  "gateScope": "all",
  "thresholds": {}
}
```

- Allow patterns never match a command containing shell control syntax (`;`, `&&`, `|`,
  redirection, substitution), so `ls*` cannot approve `ls && rm -rf /`.
- Malformed values are dropped rather than defaulted, so a broken project file cannot pin a
  value that overrides the global layer.
- There are two ways to widen the fast path, with different meanings:

  | Setting | Effect |
  |---|---|
  | `safeCommands` | Run without a decision record. For commands that are safe *on your machine*: `uv run pytest*`, `npm run test*`, `cargo test*`, `go test ./...*` |
  | `allowedCommands` | Override a dangerous-pattern match. The override is recorded, so approving `rm -rf build` by rule is visible |

  The built-in safe list is not configurable and holds read-only inspection only (`git
  status`/`diff`/`log`/`show`/`branch`, `ls`, `pwd`, `rg`, `grep`). It deliberately contains no
  command that executes project code: a test runner runs repository code, so declaring it safe
  is a decision for the machine that owns it, not a default shipped to everyone. Allow patterns
  never match a command containing shell control syntax, so `ls*` cannot approve `ls && rm -rf /`.

## What leaves the machine

An escalated call sends the following to TypeSafe's API (`api.typesafe.ai`):

- the tool name and the bash command text (truncated),
- for `write` / `edit`: the target **path** — never the file contents or the diff,
- the working directory, the matched policy reason names,
- recent **user** messages (bounded), and your policy notes.

Obvious credentials (`*_KEY=…`, `Bearer …`, JWTs, `sk-…`, `ghp_…`, PEM private keys) are
redacted on the way out. Assistant output, tool output, and file contents are never sent.
Details and the failure-mode table: [`docs/security.md`](./docs/security.md).

## Releasing

A version, a tag, and a release are cut **once, when the version is published**, so the tag list
matches what people can install. Unfinished work accumulates under `## Unreleased` in
`CHANGELOG.md` and is renamed to the version at release time:

1. `npm run check`
2. rename `## Unreleased` to `## <version>` in `CHANGELOG.md`, bump `version` in `package.json`
3. commit, `git tag -a v<version>`, `git push --follow-tags`
4. `gh release create v<version> --notes-file <(the changelog section)`
5. `npm publish`

## Development

```sh
npm install
npm test          # node:test, no network
npm run typecheck
node --experimental-strip-types scripts/calibrate.ts   # real API, needs TYPESAFE_API_KEY
```

Layout:

| Path | Responsibility |
|---|---|
| `src/policy.ts` | hard-deny, user rules, dangerous patterns, protected paths, safe commands |
| `src/call.ts` | `tool_call` → judgment state (redaction, truncation, path classification) |
| `src/intent.ts` | recent user-authored intent only |
| `src/decide.ts` | the decision-engine seam (`DecisionEngine`) |
| `src/jev/questions.ts` | the condition set, modes, severities, thresholds |
| `src/jev/availability.ts` | where the API key comes from (env or stored secret) |
| `src/jev/decide.ts` | probability → condition verdict → decision |
| `src/jev/engine.ts` | one request per call, budget guard, calibration hook |
| `src/jev/transport.ts` | the SDK, wrapped so failures become decisions |
| `src/jev/response.ts` | response re-validation (a 200 is not an answer) |
| `src/settings.ts` | global/project settings, policy notes, and the stored API key |
| `src/records.ts` | `appendEntry` records and their renderer |
| `src/ui.ts` | footer status and user-facing text |
| `src/extension.ts` | `tool_call` orchestration and command wiring |

## Acknowledgements

The deterministic pattern catalogue is adapted from
[`@nilskluewer/pi-auto-permission-gate`](https://github.com/nilskluewer/pi-auto-permission-gate)
(MIT), and the three-layer structure (fast paths → hard rules → classifier) follows the same
extension and Qwen Code's Auto Mode. The Jev design constraints (fail closed, two-sided
thresholds that keep the middle band meaningful, one request per judgment) come from measuring
the API directly — [`docs/calibration.md`](./docs/calibration.md) records the measurements and
the reasoning. Nothing here depends on a wrapper library: the Jev layer is written against the
official SDK.

## License

MIT
