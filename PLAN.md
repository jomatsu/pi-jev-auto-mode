# Implementation plan: `pi-jev-auto-mode`

An auto mode for the Pi coding agent in which a **decision-only model (JEV / TypeSafe
System One)** judges whether a tool call is within the user's intent and policy, inside a
deterministic safety envelope that JEV cannot override.

Status: **M1–M4 complete; M5 in progress.** Installed and exercised in a real Pi session
(tmux-driven): the footer reports the live engine, a hard-deny command is blocked before JEV,
an explicitly requested command is judged and allowed, the threshold table and per-condition
records render, and the credential lifecycle works (stored secret → engine switch → logout →
ask-only). 146 tests. Remaining: repeated calibration runs to settle the thresholds.

Measured probabilities and the reasoning behind every threshold:
[`docs/calibration.md`](./docs/calibration.md).

---

## 1. Why the gate is layered

Pi has no built-in permission system: extensions own the decision, through the `tool_call`
event (`{ block: true, reason }`, async allowed) plus `ctx.ui.confirm` / `ctx.ui.select`.

Two prior arts shaped the structure:

| Prior art | What was taken |
|---|---|
| `@nilskluewer/pi-auto-permission-gate` (Pi extension) | hard-deny → user rules → classifier → confirmation → no-UI block; classifier failure is fail-closed; decisions recorded with `pi.appendEntry` (out of LLM context); user policy as a Markdown note; allow patterns disabled for shell control syntax |
| Qwen Code Auto Mode | three layers: deterministic fast paths and allow rules first, then a classifier; protected "persistence surfaces" (`package.json`, `.github/workflows/`, agent config) always go through the classifier even when the target is inside the workspace |

What is different here: the classifier is **JEV**, not a chat model. JEV is a decision-only
model (unstructured state in, typed decisions out), so the call is cheap, fast, has no
tokens to inject through, and returns calibrated probabilities instead of prose that must
be parsed.

JEV facts this design leans on:

- One request can carry many `noul` questions; they are evaluated **in parallel and
  independently**, so adding questions barely changes latency.
- Question keys are not sent to the model: each question's instruction must stand alone.
- The budget (~32k tokens / ~150k characters) is shared between `state` and `questions`.
- Clear yes/no lands at 0.98/0.02, but genuinely clear conditions also land at 0.90–0.94, so
  a single 0.95 threshold is mostly "uncertain". Two-sided thresholds are required.
- Unavailable (timeout, malformed, cancelled) must never mean "approved".

## 2. Decision flow

```
tool_call(bash | write | edit)
  ├─ 0. auto mode off / tool not gated        → pass through
  ├─ 1. hard-deny (deterministic)             → block, no JEV     ┐
  ├─ 2. user disallow pattern                 → block, no JEV     ├ JEV never sees these
  ├─ 3. user allow pattern                    → allow (recorded)  ┘
  ├─ 4. built-in safe commands                → pass through (silent fast path)
  │      read-only inspection and local verification only
  ├─ 5. in-project write/edit, unprotected    → pass through (silent fast path)
  └─ 6. JEV: one request, all conditions
         ├ every condition p >= t             → allow
         ├ any condition p <= 1-t             → block (that condition's message is the reason)
         ├ any condition in between           → confirm in a UI, block without one
         └ unavailable (timeout/network/http/malformed/state_too_large)
                                              → block (fail-closed)
  └─ 7. record the decision via appendEntry (never enters LLM context)
```

Hard-deny is evaluated first and its verdict is never handed to the semantic layer, so a
mis-calibrated or manipulated judgment cannot resurrect `rm -rf /`.

## 3. JEV state and question set

`context` (session-scoped, bound when the question set is built):

- `policy` — the user-authored policy notes
- `repository` — cwd, whether it is a git repository, protected path roots plus the
  concrete protection that triggered this escalation

`value` (per call):

- `tool`, `operation`, `matched_policy_reasons`, `user_intent` (recent **user** messages only)
- `command` for bash, `path` / `relative_path` / `outside_working_directory` for file tools

Every condition is phrased so the safe state is "yes". Two axes decide how a
condition participates:

- `mode`: `required` (must be satisfied; the middle band escalates) or `hazard`
  (only a clear negative matters; the middle band is ignored)
- `severity`: `hazard` (a rejection always blocks) or `soft` (a rejection is cleared
  when the user's own request covers the call)

| rule id | mode | severity | threshold | rejects at |
|---|---|---|---|---|
| `intent_coverage` | required | hazard | 0.80 | ≤ 0.20 |
| `policy_compliance` (only when a policy exists) | required | hazard | 0.80 | ≤ 0.20 |
| `path_not_protected` (only when the deterministic layer flagged the target) | required | hazard | 0.90 | ≤ 0.10 |
| `local_scope` | hazard | soft | 0.90 | ≤ 0.10 |
| `no_outward_effect` | hazard | soft | 0.90 | ≤ 0.10 |
| `no_irreversible_damage` | hazard | soft | 0.80 | ≤ 0.20 |
| `no_secret_egress` | hazard | hazard | 0.97 | ≤ 0.03 |
| `prompt_injection_absent` | hazard | hazard | 0.80 | ≤ 0.20 |

Composition happens in code, not in the model: a rejection from a `hazard`-severity
condition blocks; a rejection from a `soft` condition is cleared when
`intent_coverage` is satisfied; an unclear `required` condition escalates to a
confirmation; otherwise the call is approved. One question, one judgment; no compound
questions, and the model never has to weigh concerns against each other.

## 4. Milestones

| # | Scope | Exit criteria | Status |
|---|---|---|---|
| M1 | repo skeleton, deterministic layer, settings, command surface, records, tests | dangerous commands blocked, safe commands pass, tests green | **done** |
| M2 | `src/jev/`: transport over `@typesafe-ai/sdk`, question set, response re-validation, probability mapping, real-API calibration | stub transport drives allow/deny/ask/unavailable deterministically; twelve real fixtures land on the expected outcomes | **done** |
| M3 | per-rule threshold overrides, tuning table, condition-level record rendering | per-condition probabilities are visible and tunable from a session | **done** |
| M4 | fail-closed, injection, abort, redaction hardening; privacy review | missing key, timeout, malformed response, and abort can never produce an allow | **done** |
| M5 | `pi install` distribution, docs, repeated calibration runs | installed and exercised in a real Pi session; the fixture set is stable across repeated runs | in progress |

## 5. Calibration and tests

- Unit tests inject a stub engine and a stub transport, so every branch — allow, deny,
  cleared-by-intent, uncertain, each unavailable reason, boundary probabilities — is
  deterministic and offline (107 tests, no network).
- The JEV layer is hand-written, so the calibration channel exposes **every** condition's
  probability, including the passing ones. That is what makes threshold tuning possible.
- `scripts/calibrate.ts` runs twelve fixture calls against the real API and prints the
  probability table; the results and the resulting thresholds are recorded in
  [`docs/calibration.md`](./docs/calibration.md).
- Measured variance between runs is ±0.05 on some conditions, so thresholds are chosen
  from bands, not from single values, and re-running is part of the tuning procedure.
- Threshold overrides live in settings (`0.5 < t <= 1`, validated) and are applied per rule;
  the tuning table in `/jev-auto-mode threshold` shows the last observed probability for each
  rule so a threshold can be chosen from what the model actually answers.

## 6. Risks and open questions

- JEV is early access: model resolution, price, and rate limits can change. The engine
  records the resolved model name and token usage in every decision record so drift is
  visible.
- Latency is 0.6–0.9 s per gated call. The answer is the fast path, not caching: keep the
  safe-command list and the "in-project write" rule generous, and never cache an approval.
- Calibration rests on one sample per fixture with ±0.05 run-to-run variance. Repeated runs
  and a larger fixture set are needed before the thresholds can be called settled.
- The command text, paths, and recent user messages leave the machine for TypeSafe.
  Documented in `docs/security.md`; not gated behind a consent prompt.
- Two gates installed at once (this and another permission extension) chain their `tool_call`
  handlers, so both can block. Documented rather than detected.
- `classifyWriteTarget` is lexical. A symlink inside the working directory can still point
  outside it; resolving that needs a filesystem call and belongs to the JEV state builder.
- The `soft`-severity design lets the user's own request clear a rejection. That grants a
  lot to a probabilistic `intent_coverage` judgment. It is currently the right trade for
  force-pushes and system installs, but it is the first thing to revisit if a wrong
  approval ever shows up in practice.
