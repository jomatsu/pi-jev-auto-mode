# Design notes

Why the gate is shaped the way it is. Measured numbers live in
[`calibration.md`](./calibration.md); failure modes and the privacy boundary live in
[`security.md`](./security.md).

## Why the gate is layered

Pi has no built-in permission system: extensions own the decision, through the `tool_call`
event (`{ block: true, reason }`, async allowed) plus `ctx.ui.confirm` / `ctx.ui.select`.

Two prior arts shaped the structure:

| Prior art | What was taken |
|---|---|
| [`@nilskluewer/pi-auto-permission-gate`](https://github.com/nilskluewer/pi-auto-permission-gate) (Pi extension) | hard-deny → user rules → classifier → confirmation → no-UI block; classifier failure is fail-closed; decisions recorded with `pi.appendEntry` (out of LLM context); user policy as a Markdown note; allow patterns disabled for shell control syntax |
| Qwen Code Auto Mode | three layers: deterministic fast paths and allow rules first, then a classifier; protected "persistence surfaces" (`package.json`, `.github/workflows/`, agent config) always go through the classifier even when the target is inside the workspace |

What is different here: the classifier is **JEV**, a decision-only model (unstructured state in,
typed decisions out). The call is cheap, has no tokens to inject through, and returns calibrated
probabilities rather than prose that has to be parsed.

JEV facts this design leans on:

- One request carries many `noul` questions; they are evaluated **in parallel and
  independently**, so adding questions barely changes latency.
- Question keys are not sent to the model: each question's instruction must stand alone.
- The budget (~32k tokens) is shared between `state` and `questions`.
- Clear yes/no lands at 0.98/0.02, but genuinely clear conditions also land at 0.90–0.94, so a
  single high threshold would report almost everything as uncertain.
- Unavailable (timeout, malformed, cancelled) must never mean "approved".

## Decision flow

```
tool_call(bash | write | edit)
  ├─ 0. auto mode off / tool not gated        → pass through
  ├─ 1. hard-deny (deterministic)             → block, no JEV     ┐
  ├─ 2. user disallow pattern                 → block, no JEV     ├ JEV never sees these
  ├─ 3. user allow pattern                    → allow (recorded)  ┘
  ├─ 4. read-only command, or user-declared safe command
  │                                           → pass through (silent)
  ├─ 5. in-project write/edit, unprotected    → pass through (silent)
  └─ 6. JEV: one request, all conditions
         ├ every `required` condition satisfied, no hazard rejected → allow
         ├ any `hazard` condition rejected    → block
         ├ any `soft` condition rejected      → block, unless the user's own request covers it
         ├ any `required` condition unclear   → confirm in a UI, block without one
         └ unavailable                        → block (fail-closed)
  └─ 7. record the decision via appendEntry (never enters LLM context)
```

Hard-deny is evaluated first and its verdict is never handed to the semantic layer, so a
mis-calibrated or manipulated judgment cannot resurrect `rm -rf /`.

## Conditions

Every condition is phrased so the safe state is "yes". Two axes decide how a condition
participates:

- `mode`: `required` (must be satisfied; the middle band escalates to a confirmation) or
  `hazard` (only a clear negative matters; the middle band is ignored)
- `severity`: `hazard` (a rejection always blocks) or `soft` (a rejection is cleared when the
  user's own request covers the call)

| rule id | mode | severity | threshold |
|---|---|---|---|
| `intent_coverage` | required | hazard | 0.80 |
| `policy_compliance` (only when a policy exists) | required | hazard | 0.80 |
| `path_not_protected` (only when the deterministic layer flagged the target) | required | hazard | 0.90 |
| `local_scope` | hazard | soft | 0.90 |
| `no_outward_effect` | hazard | soft | 0.90 |
| `no_irreversible_damage` | hazard | soft | 0.80 |
| `no_secret_egress` | hazard | hazard | 0.97 |
| `prompt_injection_absent` | hazard | hazard | 0.80 |

Composition happens in code, not in the model: one rejection from a `hazard`-severity condition
blocks, a `soft` rejection is cleared by a satisfied `intent_coverage`, an unclear `required`
condition escalates, otherwise the call is approved. One question, one judgment; no compound
questions, and the model never has to weigh concerns against each other.

`intent_coverage` is the only permission question. It reads user-authored messages only — never
assistant text, tool output, or file contents — so repository content cannot argue for its own
approval.

## Fast paths

The gate is only tolerable because most calls never reach it:

- read-only inspection (`git status`/`diff`/`log`/`show`/`branch`, `ls`, `pwd`, `rg`, `grep`)
- commands the user declares in `safeCommands`
- writes and edits inside the working directory that do not touch a protected path
- deletions scoped to a subdirectory of the working directory

A test runner is deliberately **not** in the built-in list. It executes repository code, so
declaring it safe is a decision for the machine that owns it (`safeCommands`), not a default
shipped to everyone.

## Tests

157 tests, none of which need a network or an API key: the engine and transport are stubbed so
every branch — allow, deny, cleared-by-intent, uncertain, each unavailable reason, boundary
probabilities — is deterministic. The real API is exercised by two scripts that are not part of
the published package:

- `scripts/calibrate.ts` sends the fixture set and prints every condition's probability.
- `scripts/e2e.ts` runs the same fixtures through the real gate path (deterministic layer,
  real JEV, block/ask routing, records) and compares the decision against the expectation.

## Remaining work

- **Thresholds are calibrated on one person's twelve fixtures**, one sample each, with ±0.05
  run-to-run variance. They are a starting point; `calibration.md` documents how to choose them
  from your own data, and `/jev-auto-mode threshold` shows the last observed probability per
  rule so the adjustment is informed rather than guessed.
- **`classifyWriteTarget` is lexical.** A symlink inside the working directory that points
  outside it is not detected by the deterministic layer.
- A command that changes directory and then deletes is judged by its text and intent, not by a
  simulated shell.
