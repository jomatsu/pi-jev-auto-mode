# Changelog

## 0.1.0

Initial release.

- Two-layer gate: a deterministic policy envelope (hard-deny, allow/deny patterns,
  dangerous-command detection, protected paths) and a JEV semantic layer that only sees
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
