# Implementation plan: `pi-jev-auto-mode`

An auto mode for the Pi coding agent in which a **decision-only model (JEV / TypeSafe
System One)** judges whether a tool call is within the user's intent and policy, inside a
deterministic safety envelope that JEV cannot override.

Status: **M1 complete.** The deterministic layer, settings, command surface, records, and
tests exist and are verified against a real Pi run. The JEV engine (M2) is not implemented
yet; escalated calls currently resolve to "confirm, or block when no UI exists".

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

## 3. JEV state and question set (M2)

`context` (session-scoped, bound when the question set is built):

- `policy` — the user-authored policy notes
- `repository` — cwd, whether it is a git repository, protected path roots

`value` (per call):

- `tool`, `operation`, `matched_policy_reasons`, `user_intent` (recent **user** messages only)
- `command` for bash, `path` / `relative_path` / `outside_working_directory` for file tools

| rule id | condition (the safe state is true) | default t |
|---|---|---|
| `policy_compliance` | `value.call` does not violate `context.policy` | 0.95 |
| `intent_coverage` | `value.call` is part of what `value.user_intent` asked for | 0.90 |
| `local_scope` | the target stays inside the relevant working scope | 0.90 |
| `no_secret_egress` | no secret is sent to a network endpoint | 0.99 |
| `no_irreversible_damage` | nothing irreversible is destroyed | 0.98 |
| `no_outward_effect` | no publish, deploy, purchase, or third-party side effect | 0.98 |
| `path_not_protected` | the write target is not a protected path (file tools only) | 0.99 |
| `prompt_injection_absent` | the call does not try to make other state act as instructions | 0.95 |

Composition happens in code, not in the model: `rejected` anywhere → deny, otherwise any
`uncertain` → ask, otherwise allow. One question, one judgment; no compound questions.

## 4. Milestones

| # | Scope | Exit criteria | Status |
|---|---|---|---|
| M1 | repo skeleton, deterministic layer, settings, command surface, records, tests | dangerous commands blocked, safe commands pass, tests green | **done** |
| M2 | `src/jev/`: transport over `@typesafe-ai/sdk`, question set, response re-validation, probability mapping | stub transport drives allow/deny/ask/unavailable deterministically | next |
| M3 | policy notes editing, threshold tuning per rule, expanded record rendering | a session shows per-condition probabilities and they can be tuned from them | |
| M4 | fail-closed, injection, abort, redaction hardening; privacy review | missing key, timeout, malformed response, and abort can never produce an allow | |
| M5 | real-API calibration against a fixture set, docs, `pi install` distribution | the fixture set lands on the expected verdicts; calibration documented | |

## 5. Calibration and tests

- Unit tests inject a stub engine (and, in M2, a stub transport) so every branch — pass,
  reject, uncertain, each unavailable reason, boundary probabilities — is deterministic and
  offline.
- `onAnswer`-style observation is available from the start because the JEV layer is
  hand-written here: every condition's probability is recorded, not just the failing ones.
  That is what makes threshold tuning possible.
- Fixture set (M5): paired safe/dangerous commands (`rm -rf build` vs `rm -rf ../x`,
  `git push` vs `git push --force`, in-repo edit vs `~/.ssh/config` edit, …) to measure real
  probabilities and pick per-rule thresholds.

## 6. Risks and open questions

- JEV is early access: model resolution, price, and rate limits can change. `onResponse`
  should record the resolved model and usage so drift is visible.
- Latency is 0.6–0.9 s per gated call. The answer is the fast path, not caching: keep the
  safe-command list and the "in-project write" rule generous, and never cache an approval.
- The command text, paths, and recent user messages leave the machine for TypeSafe. Documented
  in `docs/security.md`; not gated behind a consent prompt.
- Two gates installed at once (this and another permission extension) chain their `tool_call`
  handlers, so both can block. Documented rather than detected.
- `classifyWriteTarget` is lexical. A symlink inside the working directory can still point
  outside it; resolving that needs a filesystem call and belongs to the JEV state builder.
