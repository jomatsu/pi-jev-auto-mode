# Security notes

## The shape of the problem

A coding agent with shell access can be talked into almost anything by the content it reads:
a dependency's README, a test fixture, an issue body, a comment in the file it was asked to
fix. A permission gate therefore cannot be "a second opinion from another chat model". It has
to be an envelope the agent cannot argue its way out of, plus a narrow judgment for the cases
the envelope cannot decide on its own.

This package splits those two responsibilities and keeps the envelope authoritative.

## What the semantic layer may and may not do

| Allowed | Not allowed |
|---|---|
| Approve a call the deterministic layer escalated | Approve a hard-deny command |
| Refuse a call that looks required by the task | Override a user deny pattern |
| Report "uncertain", which becomes a confirmation | Widen the set of protected paths |
| Clear a `soft` hazard rejection when the user's own request covers the call | Clear a `hazard`-severity rejection (secret egress, credential stores, injection) |

The order in `evaluateToolCall` is the enforcement: hard-deny and user rules return before the
engine is constructed or called at all. There is no code path in which a probabilistic verdict
is consulted for a hard-deny target.

### The soft/hazard split, and why it is the riskiest part of the design

A rejection from a condition marked `severity: soft` (`local_scope`, `no_outward_effect`,
`no_irreversible_damage`) is cleared when `intent_coverage` is satisfied. This is what makes
`git push --force origin feature/x` after "force push this branch" an approval instead of a
block, and it is the only place where a probabilistic judgment grants permission for an
irreversible action.

Three things bound the risk:

1. The hard-deny patterns for catastrophic targets (forced push to a protected branch, root
deletion, disk writes) run first and cannot be reached by any semantic verdict.
2. Content-based authority does not count: `intent_coverage` reads user-authored messages
only. A README that says "run this installer" is not a user request, and the fixture set
measures that case as `ask`.
3. `severity: hazard` covers the conditions where consent should not be sufficient at all:
sending secret material, writing credential stores, and text that tries to steer the judgment.

If a wrong approval ever appears in practice, this is the mechanism to remove first.

## Failure modes and what happens

Everything below resolves to **block**. Silence is never consent.

| Failure | Resolution |
|---|---|
| No semantic engine configured (no API key) | confirm in a UI, block without one |
| API key missing or rejected | block, with the reason surfaced to the model |
| Login with a key the API refuses | the key is not stored, so a typo cannot become a permanently blocking gate |
| Login while the API is unreachable | the key is not stored and the command says it could not verify |
| Timeout / connection error | block (`timeout`, `network`) |
| 5xx or 429 after retries | block (`http`) |
| 4xx that retries cannot fix | block (`http`) — not rethrown, so the gate cannot fail open |
| Response shape wrong, or a condition missing from the answer | block (`malformed_response`) |
| State + questions over the shared budget | block (`state_too_large`) before the request is sent |
| Engine throws | block (`engine_error`) |
| Request cancelled (Esc) | block |
| No UI available for a confirmation | block (`no-ui`) |
| A condition answered by fewer than all keys | block (`malformed_response`) — a missing answer is never an approval |

A confirmation is not a bypass: it runs only when the semantic layer said `uncertain`, never
when it said `deny` or when no decision was available.

## Injection stance

- The user intent sent for judgment is built from **user-authored messages only**. Assistant
  text and tool output are excluded, because they carry repository content and command output
  and would otherwise let a file argue for its own approval.
- File contents and diffs are never sent. Only paths.
- `AGENTS.md` / `CLAUDE.md` and the agent configuration directories are treated as protected
  paths: a write there changes what the agent believes it was told.
- One dedicated condition (`prompt_injection_absent`) asks whether the call is trying to make
  other state act as instructions.
- The gate never returns a Jev rationale verbatim as a system-level instruction; a block
  reason is a tool-call error string, which is the weakest channel it can use.

## What is sent to TypeSafe

Judgment requires the content to leave the machine. The API is `api.typesafe.ai`, and the
payload is deliberately narrow:

| Sent | Not sent |
|---|---|
| tool name, bash command text (truncated) | file contents, diffs, `write` bodies |
| write/edit target path, cwd | tool output, assistant messages |
| matched policy reason names | environment variables |
| recent user messages (bounded, ≤4k chars) | the API key itself |
| policy notes | |

The API key is stored as a `0600` file under `<agentDir>/secrets/`, the same place Pi keeps its
own credentials. It is never written to the settings file, and it is never part of the judgment
state: it travels only in the `Authorization` header to `api.typesafe.ai`, so it cannot come
back out through a decision record.

Redaction runs before the state is built: `*_KEY=` / `*_TOKEN=` / `*_SECRET=` assignments,
`Bearer …`, JWTs, `sk-` / `rk-` keys, `ghp_` / `gho_` tokens, `AKIA…` access key IDs,
`apikey_…` keys, and PEM private keys become `<redacted>` markers. Redaction is a safety net,
not a guarantee — an unusual secret format will pass through. Lower
`maxStateCharacters`, or keep a command out of the gate by adding a deny/allow rule, if a
repository must not produce outbound text at all.

Records written to the session store the decision, the matched reasons, the rationale, the
model name, and per-condition probabilities. They are local and do not enter the model's
context.

## Known limits

- `classifyWriteTarget` is lexical (no `realpath`), so a symlink inside the working directory
  pointing outside it is not detected by the deterministic layer.
- Command matching is conservative pattern matching, not a shell parser. `rm -rf build` is
  recognized as scoped; obfuscated equivalents (`xargs`, command substitution, `sh -c`) are
  escalated rather than recognized.
- A command that `cd`s elsewhere and then deletes is judged by its text and intent, not by a
  simulated shell.
- The probability thresholds are calibrated on one person's data, one sample per fixture,
  with ±0.05 run-to-run variance. See [`calibration.md`](./calibration.md); treat the
  thresholds as a starting point and tune them from the recorded probabilities.
