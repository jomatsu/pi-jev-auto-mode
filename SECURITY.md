# Security

This extension stands between a coding agent and your shell, so its own failure modes matter.

## Reporting

Open a private security advisory on the repository, or an issue if the report does not need to
stay private. Please include the tool call, the recorded decision (`/jev-auto-mode` records
are expandable in the transcript), and the JEV probabilities if you have them.

## What is in scope

- A call that should have been blocked and was not.
- A call that was approved without the semantic layer being consulted.
- Credential or file content leaving the machine inside a judgment request.
- A stored API key readable by another user, or written somewhere other than
  `<agentDir>/secrets/` with mode `0600`.

## Design summary

The gate is two layers and the order is the enforcement:

1. A deterministic envelope (hard-deny, user rules, dangerous-command patterns, protected
   paths). Hard-deny returns before the semantic layer is constructed, so a probabilistic
   verdict can never resurrect it.
2. JEV, which only sees calls the first layer escalated.

Anything that cannot be decided — no key, timeout, malformed response, a response missing an
answer, cancellation, an oversized request — blocks. See
[docs/security.md](./docs/security.md) for the failure-mode table, what is sent to the API, and
the known limits (including the `soft`-severity clearing, which is the mechanism to remove first
if a wrong approval ever appears).
