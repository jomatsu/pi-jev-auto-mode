# Decision providers

These backends judge tool execution with probabilities. They do not choose the coding
agent's chat model. The deterministic gate and its `uncertain` setting are unchanged.

## Selection

Set `JEV_AUTO_MODE_PROVIDER` in the environment used to start Pi. Unset means `typesafe`;
the presence of another provider's API key never switches the provider automatically.
Restart Pi after changing the environment. Project JSON cannot select a provider or
redirect its endpoint. There is no fallback to another provider when a request fails.

| Provider | Model | Configuration |
|---|---|---|
| `typesafe` (default) | `jev-latest` by default; pin a release with `/jev-auto-mode model` | Existing `TYPESAFE_API_KEY` or stored login key; `TYPESAFE_DEFAULT_MODEL` remains supported |
| `perplexity` | `pplx-decider-v1-27b` by default | `PERPLEXITY_API_KEY` |
| `cloudflare` | `clef` by default; also `clef-flash` | `CLOUDFLARE_AUTH_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` |
| `strands` | The checkpoint loaded by the local server | Optional `STRANDS_DECIDER_BASE_URL`; default `http://127.0.0.1:8000` |
| `openai` | `gpt-6-luna` by default | `OPENAI_API_KEY` |

`JEV_AUTO_MODE_MODEL` overrides the remote model. For Cloudflare it must be `clef` or
`clef-flash`. Leave it unset for Strands: the server owns the checkpoint selection and
reports its actual model name. OpenAI currently documents `gpt-6-luna` as the only
Decisions model; another value is sent as given and rejected by the API if unsupported.

### Jev releases (TypeSafe)

TypeSafe publishes several Jev releases. The default is `jev-latest`, which TypeSafe
resolves to the newest one, so judgments follow new releases automatically. To keep a
fixed release, pin it:

```
/jev-auto-mode model               # current model and the releases available to the key
/jev-auto-mode model jev-1.13.0    # pin (saved as "jevModel" in the global settings)
/jev-auto-mode model latest        # follow jev-latest again
```

A release is saved only after `GET /v1/models` lists it for the current key, so a typo
cannot turn into a gate that blocks every escalated call. The model used for TypeSafe is
the first of: `JEV_AUTO_MODE_MODEL`, `TYPESAFE_DEFAULT_MODEL`, the `jevModel` setting,
`jev-latest`. `/jev-auto-mode status` shows which one applied. `jevModel` is ignored by
the other providers.

With the selected provider's credentials already configured:

```sh
JEV_AUTO_MODE_PROVIDER=perplexity pi
JEV_AUTO_MODE_PROVIDER=cloudflare JEV_AUTO_MODE_MODEL=clef-flash pi
JEV_AUTO_MODE_PROVIDER=strands STRANDS_DECIDER_BASE_URL=http://127.0.0.1:8000 pi
JEV_AUTO_MODE_PROVIDER=openai pi
```

`/jev-auto-mode status` shows the provider, model and credential source without displaying
the key. Login/logout manages only TypeSafe credentials and does nothing while another
provider is selected. This extension does not store additional provider credentials.

## Wire compatibility

The gate sends its existing `{ value, context }` state and named `noul` questions in one
request. The Perplexity, Cloudflare and Strands adapters require `type: "noul"` and a finite
`noul` probability in `[0, 1]` for each answer (OpenAI's predicate shape is described below). TypeSafe's existing SDK and response validation are unchanged.
Every requested key must be present. There is no conversion from generated text, labels,
or `choice`/`score` confidence. A separate `confidence` field is not required for `noul`.

- **Perplexity:** `POST https://api.perplexity.ai/v1/decisions` with Bearer auth and exactly
  `state`, `questions`, `model`. The endpoint has no trailing slash. The adapter limits
  requests to 128 questions. [Official Decisions contract](https://docs.perplexity.ai/docs/decisions/quickstart).
- **Cloudflare:** `POST https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/@cf/cloudflare/{model}`.
  The selected `clef` or `clef-flash` also appears in the request body. A REST response must
  have `success: true`, an empty `errors` array and valid answers inside `result`; the
  Workers binding's bare response is not accepted here. Maximum 64 questions.
  [Clef contract](https://developers.cloudflare.com/workers-ai/models/clef/),
  [REST envelope](https://developers.cloudflare.com/workers-ai/get-started/rest-api/).
- **Strands:** `POST /v1/systemone` without credentials or a model selector. Only loopback
  HTTP origins are accepted (`127.0.0.1`, `localhost`, `[::1]`); `localhost` is resolved to
  the numeric loopback.
  [Server schema](https://github.com/strands-labs/strands-decider/blob/main/src/strands_decider/schema.py).
- **OpenAI:** `POST https://api.openai.com/v1/decisions` with Bearer auth and exactly
  `model`, `input`, `questions`. OpenAI has no keyed `noul` questions, so each one becomes a
  `predicate` question named after its key, in key order; its instructions and `criteria`
  are folded into the predicate's `instructions` text ("True when: …", "False when: …").
  `input` is the same `{ value, context }` state serialized as JSON text. The response's
  `answers` array must have one entry per question, in the same order, echoing each name,
  with `type: "predicate"` and a finite `probability` in `[0, 1]` — the predicate
  probability is P(true), the same meaning as `noul`. A `refusal` for any question blocks
  the call (`refused`); there is no conversion from `choice` or `score` answers. Maximum
  200 questions. [Guide](https://developers.openai.com/api/docs/guides/decisions),
  [API reference](https://developers.openai.com/api/reference/resources/decisions/methods/create).

Redirects are disabled for all HTTP adapters.

Perplexity, Cloudflare and OpenAI use the existing per-attempt timeout and retry limit for network
errors (including a connection lost while the response body is being read), 408, 429 and 5xx.
Only a fully received body that is not valid JSON counts as a malformed answer. Other HTTP errors and malformed answers are not retried.
`Retry-After` is honored when it fits the gate's timeout budget; a longer wait returns a
failure instead of retrying early. Strands uses the timeout but never automatically
retries, because an HTTP failure may leave model inference running. Cancellation,
timeout, exhausted retries and malformed responses block under `uncertain: allow`,
`deny`, and `ask` alike. A valid middle-band judgment alone follows `uncertain`
(default `allow`, unchanged since 0.4.1).

## Local Strands and validation limits

The adapter does not install, download or launch Strands. A separately managed local
server is required. The published checkpoint is
`StrandsAgents/strands-decider-2B-hobson-v19`. Use the server's `--strict-window` option
to reject oversized prompts instead of silently truncating state. The character budget
in this extension is not a model tokenizer and does not guarantee the checkpoint's token
window is respected. [Official inference guide](https://github.com/strands-labs/strands-decider/blob/main/docs/inference.md).

Strands describes its server as experimental, unauthenticated and unverified for concurrent
use. Its inference engine keeps mutable request state. Use a dedicated server reached
directly on loopback; do not put multiple ports or proxies in front of the same engine.
Adapters in one Pi runtime share a queue for each loopback port, including `localhost`,
`127.0.0.1` and `[::1]` aliases. The queue is held until the complete response body has
been read, not merely until headers arrive.

After a dispatched request is cancelled, times out, or loses its connection before its
response is fully read, inference completion is unknown. The adapter permanently blocks
that endpoint for the runtime with `strands_completion_unknown`. HTTP 408 and 5xx also
trigger this conservative stop. Already queued requests and new adapters for that endpoint
block without sending; a late response, settings change, or extension reload does not
clear the stop. A fully received validation error (such as 422) or malformed answer blocks
the current decision but permits a later request. Cancellation before dispatch does not
halt the server queue.

To recover, stop the dedicated Strands server and verify that its process and inference
workers have exited. Start a fresh server, then completely restart Pi. Restarting only Pi
can lose the stop while old inference is still running, so it is not a safe recovery.
There is no automatic unlock or health-check reset.

This coordination covers one Pi runtime only; it cannot stop model inference or coordinate
other Pi processes, worker runtimes, or unrelated clients. Do not share the server with
them. This remains an experimental integration, not a claim of general Jev API
compatibility or production permission-gate accuracy.

All providers currently share the existing questions, Jev-measured default thresholds and
configured overrides. These thresholds have **not** been calibrated on the new models.
Evaluate each model on your own labeled operations before relying on its probabilities;
`scripts/calibrate.ts` still targets TypeSafe only.

The new adapters are tested with offline mocked contracts and the real deterministic gate.
No live hosted API call, model download, or local Strands inference was used for validation.
The OpenAI adapter follows the public-beta Decisions API reference as published on
2026-10-17; OpenAI expects the API to reach general availability soon, so recheck the
contract if requests start failing validation. The `DecisionEngine` interface remains the
extension point for further adapters.
