# Changelog


## 0.4.0

**The semantic layer now sees everything the deterministic layer cannot vouch for, and it does
not stop ordinary work.**

- `gateScope` (default `all`) replaces the denylist as the way calls are selected. A dangerous
  pattern can only recognise a shape someone wrote down first: a request that uploads a file
  (`curl -d @...`) once ran with no judgment at all because no pattern described it, and adding
  patterns to a denylist is a race that never ends. Under `all`, the deterministic layer names
  what it can vouch for and everything else is judged. `matched` keeps the old behaviour.
  `/jev-auto-mode scope all|matched` switches between them.
- **The intent question is asked only about commands the deterministic layer recognised as a
  dangerous shape, and only a clear "this was not requested" blocks.** Asked about every command,
  it blocked ordinary work the request never mentioned — an unrequested `mv`, `cp`, `tar`,
  `chmod +x`, or `node -e`. An auto mode that stops for those has no reason to exist. Measured
  after the change: those run, while an unrequested `git reset --hard`, `npm publish`, `rm -rf`,
  or `sudo` still blocks (p = 0.04–0.11).
- Read-only inspection is now a real fast path, because under `all` it carries the load the
  denylist used to carry: `cat`, `head`, `tail`, `wc`, `find`, `jq`, `diff`, `sort`, `stat`,
  version probes, and read-only git subcommands. Destructive variants (`find -delete`,
  `git tag -d`, `push --force`) still match dangerous patterns and are judged.
- The user's `safeCommands` outranks a dangerous-pattern match; the built-in read-only list does
  not, so `grep secret ~/.ssh/id_ed25519` is judged even though `grep` is read-only.
- `Escalated:` replaces `Matched:` in the confirmation dialog, because under `all` the reasons
  are not all pattern matches.

## 0.3.0

The 0.2.0 default resolved the middle band as a block, but two conditions were still
`required`, which made the gate strict for structurally wrong reasons rather than measured
ones. Corrected:

- `intent_coverage` 0.80 → **0.60**. Measured answers are 0.77–0.98 when the user asked and
  0.06–0.15 when they did not, so 0.80 sat on top of the "asked" cluster instead of inside the
  empty band between the two. The middle band is now (0.40, 0.60).
- `policy_compliance` required → **hazard**. It measured 0.66–0.85 on calls where nothing was
  wrong, so as a requirement it blocked every gated call the moment a policy was configured.
  Now only a clear violation stops a call.
- `path_not_protected` required → **hazard**. An unclear answer no longer blocks on its own; the
  user's request decides. A target the model clearly identifies as a credential store still
  blocks (`.env` measured p = 0.02, `~/.ssh` p = 0.03).
- New `no_fetched_code_execution`, required, asked only for commands the deterministic layer
  already recognised as downloaded-script execution. `curl | bash` stays blocked (p = 0.02)
  without making every other call strict.
- `.env.example`, `.env.sample`, `.env.template`, and `.env.dist` are no longer treated as
  credential stores: templates belong in the repository.
- The intent window widened from 8 messages / 4000 characters to 12 / 6000, so an ongoing task
  does not lose the request that justifies it and look unrequested as a result.

## 0.2.0

- The confirmation dialog is bounded: it showed the whole command, and since Pi's dialogs do not
  clip their content a long command produced a dialog taller than the terminal. It now shows a
  short preview and says what was hidden.
- **The middle band no longer asks the user by default.** An auto mode that stops to ask has
  handed the decision back to a human, and the agent can always ask in conversation if it needs
  guidance. A judgment that is neither satisfied nor rejected now blocks, so the gate never
  takes over the screen.
- `uncertain` setting and `/jev-auto-mode uncertain deny|ask|allow` control it. `deny` is the
  default; `ask` restores the confirmation dialog; `allow` trusts the band.
- `/jev-auto-mode threshold edit` picks a rule and prompts for a value, showing each rule's
  current threshold next to the last probability the model returned for it.


## 0.1.1

- Correct the product name. It is **Jev** — TypeSafe's System One model, spelled with a
  capital J and lowercase `ev`, as in their announcement, FAQ, and the model id
  `typesafe-ai/jev` — not "JEV". Fixed in the README, docs, source comments, and the package
  description. The `0.1.0` metadata cannot be edited, so this release exists to carry the
  corrected name. No behavioral change.

## 0.1.0

Initial release.

- Two-layer gate: a deterministic policy envelope (hard-deny, allow/deny patterns,
  dangerous-command detection, protected paths) and a Jev semantic layer that only sees
  what the first layer escalated.
- Conditions carry a `mode` (`required` / `hazard`) and a `severity` (`hazard` / `soft`),
  calibrated against measured probabilities from the real API (`docs/calibration.md`).
- Fail-closed everywhere: no key, timeout, malformed response, cancellation, missing
  answer, or oversized request all resolve to a block rather than an approval.
- `/jev-auto-mode` command surface: `on|off`, `login|logout`, `policy`, `threshold`.
- Decision records via `pi.appendEntry`, kept out of the LLM context, expandable to a
  per-condition tuning sheet.
- Network uploads of local data and reads of credential material are gated: a `curl -d @file`
  that matched nothing ran with no judgment before this.
- `pi install` from npm or git; tagged `pi-package` for the package gallery.
