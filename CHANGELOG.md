# Changelog

## 0.2.0

- **The middle band no longer asks the user by default.** An auto mode that stops to ask has
  handed the decision back to a human, and the agent can always ask in conversation if it needs
  guidance. A judgment that is neither satisfied nor rejected now blocks, so the gate never
  takes over the screen.
- `uncertain` setting and `/jev-auto-mode uncertain deny|ask|allow` control it. `deny` is the
  default; `ask` restores the confirmation dialog; `allow` trusts the band.
- `/jev-auto-mode threshold edit` picks a rule and prompts for a value, showing each rule's
  current threshold next to the last probability the model returned for it.

## 0.1.2

- Fix the screen thrashing that happened whenever a judgment was delegated to the user: the
  confirmation dialog was handed the whole command, and Pi's dialogs do not clip their content,
  so a long command produced a dialog taller than the terminal. The dialog now shows a bounded
  preview and says what was hidden.

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
