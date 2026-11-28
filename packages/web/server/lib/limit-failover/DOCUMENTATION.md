# Limit failover

## Ownership

What happens when a provider request fails: switching the provider to its next
stored account, and moving the session along the user's fallback models. Three
settings drive it, off by default:

- `accountSwitchProviders`: provider ids the user opted in on the provider's
  page in Settings → Providers (`ProviderAccountSwitchToggle.tsx`).
- `fallbackModels`: an ordered list of at most eight `provider/model` entries
  with per-entry thinking levels, Settings → Sessions → Session defaults —
  the order the session moves through as each model fails.
- `fallbackModel`/`fallbackVariant`: the single-model setting the list
  replaced. Read only while `fallbackModels` is absent from the stored
  settings; once the list exists — even empty — the pair is ignored, though a
  stale copy may remain in the settings file.

The module owns the managed OpenCode plugin that reports limit failures
(`runtime.ts`, `PLUGIN_SOURCE`), the decision (`decide`), and the
`openchamber:limit-failover` event the clients turn into a toast
(`packages/ui/src/hooks/useLimitFailoverNotices.ts`; the schema the client
validates with lives in `packages/ui/src/lib/limitFailoverEvent.ts`). The
event's `model` kind carries `reason: 'limit' | 'error'` — what moved the
session — so a switch driven by a provider's overload or a dead network is
not reported as a spent usage limit; an older server omits the field. The
`model-return` kind announces the switch back, and the toast words it as a
return rather than another fall. The managed config layer
(`../opencode/managed-config-file.ts`) lists the plugin; the plugin reaches the
server through the agent tool's callback address and token
(`../agent-tool/DOCUMENTATION.md`, *Runtime flow*), and the route checks the
same token.

## Flow

1. OpenCode calls the plugin's `session.retry` hook on every failed attempt,
   including failures it would not retry (`provider.quota`). Every error type
   is reported; the server decides which ones act on.
2. For `provider.quota`, `provider.free-limit` (OpenCode's own free tier, a
   separate type since OpenCode 2.1.2), `provider.budget-limit` and
   `provider.model-budget-limit` (an OpenCode Console spend limit of the
   workspace or of one model, separate types since 2.2) and
   `provider.rate-limit` the plugin
   posts the error with OpenCode's `retryAfterMs`,
   OpenCode's proposed decision, the provider's stored accounts and the active
   one to `POST /api/openchamber/limit-failover`. Every other error type is
   posted the same way; the server acts on it only when OpenCode has given up
   retrying (`proposed.retry === false`).
3. `decide` answers `activate-credential`, `switch-model`, `retry` or `none`.
   A switch carries a ticket.
4. The plugin calls `credential.activate` or `session.switchModel` and sets the
   decision to retry now. OpenCode repeats the same step, and every attempt
   resolves the active credential and the session's model again
   (`core/src/model-resolver.ts`, `session/runner/llm.ts` in OpenCode), so the
   next attempt runs on the new account or model and no tool call repeats.
   On `none`, or any failure on the way, OpenCode's own decision stands.
5. The plugin reports the ticket's outcome to `POST .../limit-failover/settle`.
   An applied switch is broadcast as `openchamber:limit-failover`; a failed one
   is forgotten, so its account does not count as just switched to.

Returning to the original model: once a session has fallen forward to a
fallback model, the plugin's `chat.message` hook asks
`POST .../limit-failover/return` with every new message. The server answers
`switch-model` back to the model the session came from once
`FALLBACK_RETURN_MS` has passed since the last switch and that model's failure
window has run out, and forgets the episode. A session the user moved to a
model outside the chain ends its episode without a switch.

The episode is recorded when the switch decision is made, not when the
plugin's settle report arrives: a lost report would otherwise leave the
session on the fallback model with nothing to return from. A settle that
reports the switch failed retracts the record it owns, and so does the next
return probe that finds the session standing on a model other than the chain
one it was sent to. All of this state is in memory, so a server restart also
ends every episode: sessions stay where they are until a new failure moves
them again.

Verified end to end on OpenCode 2.0.32 with a fake provider: an exhausted
account switched to the next one and the turn finished there; with only a
fallback set the session moved to it; with every account out it switched
accounts first, then moved to the fallback.

## Invariants

- Nothing changes unless the user opted in: a provider not in
  `accountSwitchProviders` keeps its account, and an empty fallback list never
  moves a session.
- A rate limit counts only when the wait is at least `LONG_WAIT_MS`, from
  OpenCode's proposed delay, the error's `retryAfterMs` or the reset hint in
  the body. Short throttles stay
  OpenCode's backoff.
- A failure that is not a usage limit acts only when OpenCode's proposed
  decision is not to retry: while OpenCode backs off and retries on its own,
  the session stays on its model. The model then stays skipped for that
  session for `GENERIC_EXHAUSTION_MS`.
- An account that hit its limit is skipped until the error's `retryAfterMs`
  runs out, else until the reset the body names, else for the wait OpenCode
  proposed, else for
  `DEFAULT_EXHAUSTION_MS`. The marks live in memory, so a server restart
  forgets them and the next failure marks the account again.
- A model a session fell away from is skipped for that session until its
  failure window runs out, so a chain of two models moves to the second one
  instead of falling back to the first. The marks are per session: another
  session on the same model still gets the top of the chain. They also gate
  the return probe, so a session does not bounce back onto a model whose
  limit is still in force.
- Clients hear about a switch only after the plugin made it.
- With no stored account active (an environment key serves the provider),
  every stored account is a candidate.
- A chain model is never chosen for a session already on it, and the chain
  ends in OpenCode's own error once every entry has failed for the session —
  no loop.
- Decisions run one at a time, reports and return probes on the same queue.
- `policy.ts` derives report input and parsed output types from the existing
  Zod schema. HTTP reports and provider error bodies still pass through those
  schemas; stored model selections still use the shared string parser.
- Optional fallback settings accept explicit `undefined` because the settings
  normalizer writes it when a stored selection is empty.
- Concurrent failures on the same account share a pending activation decision
  and produce no second announcement. An unsettled ticket expires silently;
  a plugin that stops mid-switch cannot claim that a switch happened.
- Works only with an OpenCode OpenChamber starts: an external OpenCode
  (`OPENCODE_HOST`, skip-start) and VS Code never load the plugin, the
  Settings hints say so, and VS Code hides all the controls.

## Decisions

### Runtime conversion contracts

`createLimitFailoverRuntime` and `registerRoutes` use the request, application
and handler types from `../shared/http-contracts.js`. The shared Express
declaration connects `express.json` to those contracts. Authorization still
checks the request at runtime. The route parses its unchecked request body with
the policy's exported Zod schema; only its result supplies the decision's
report type. The settings reader can return unchecked stored fields, so the
runtime keeps the array check and narrows string selections before calling the
model parser. Other selection values still produce no model or variant.
Ticket announcements and decision results use the
runtime's exported contracts. The serialized queue holds either a decision or
the `undefined` returned by its rejection handler.

### Why the generated plugin has no imports and not shared server dependencies

OpenCode loads the plugin from its own directory, where those dependencies are
not installed. The callback address and token supply the server boundary.

### Why the plugin asks the server, and not the settings baked into the plugin

The settings could be written into the generated plugin the way the agent
tools are. The account choice also needs state only the server keeps (which
accounts ran out and when they reset), so the decision lives there and the
plugin stays a reporter that executes the answer.

### Why the plugin loads only while an option is on

With every option off, each failed request would cost the plugin three OpenCode
reads and a round trip to the server, only to hear `none`, and every new
message would pay the return probe. With an option on the cost is real but
bounded: every failed attempt pays those reads and a round trip even when the
answer is `none`, and every new message pays the return probe, which is an
awaited fetch with a two-second timeout. The managed config
lists the plugin only while `isLimitFailoverConfigured` holds, and the settings
are in `MANAGED_PLUGIN_SETTINGS_KEYS` (`../settings/settings-runtime.ts`),
so turning one on rewrites the watched config and OpenCode loads the plugin
without a restart (checked live on 2.0.32). Installs where the user's own
environment sets `OPENCODE_CONFIG` need a restart, like the agent tools.

### Why a switch is global, and not per session

An account's limit belongs to the account. OpenCode keeps one active
credential per integration, and leaving any session on the exhausted account
would only fail it again.

### Why other errors act only when OpenCode gives up

OpenCode already backs off and retries the transient answers (5xx, throttles,
network hiccups) on its own. Switching a session to the next model on the
first blip would move people off their model for nothing and burn fallback
capacity on noise. The plugin therefore reports everything, but the server
lets OpenCode's proposed decision stand while it still wants to retry, and
takes over the moment OpenCode gives up. Usage limits keep their own rule:
they act early, but only when the wait is long.

### Why the return probe rides on `chat.message`

A session on a fallback model should go back to its own model when that model
recovers, and the only moments OpenCode hands the plugin are failed attempts
and new messages. A new message is the moment the user is about to spend the
next turn somewhere, so the hook asks the server once per message whether the
cooldown has passed; the server answers `none` until it has. A failed attempt
would probe too late (the request already failed on the fallback), and a timer
in the plugin would need state the server keeps anyway.

### Why the return respects the failure window

The cooldown alone would send a session back onto a model whose quota resets
in an hour, fail one request there, and fall forward again, once per cooldown
until the limit lifts. The model marks that drove the chain forward also gate
the return, so the session comes back when the model can actually serve it.

### Why a report on an account switched to a minute ago gets one plain retry

The plugin reads the active account when the hook runs, not the account the
failed request used. Sessions on one account fail together: after the first
report switches A to B, a second session's request that went out with A reports
B as active. Marking B as exhausted then would be wrong, so within
`SWITCH_GRACE_MS` of a switch each session gets one retry on the new account
without a mark. A second failure from that session on that account is real.
