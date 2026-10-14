# Engine Registry (`lib/engines`)

The host's answer to "add an agent engine any day": an engine is a directory
entry, not a code change.

## Contract

Onboarding an engine = drop a descriptor file into the engines directory
(`OC_ENGINES_DIR`, default `/etc/oc-engines`) with the engine's adapter
service running. No host restart is required — the registry re-reads the
directory on a short cache (stale-while-revalidate, see `index.js`).

```
OC_ENGINES_DIR/codex.json
{
  "apiVersion": 1,
  "id": "codex",
  "name": "Codex",
  "protocol": "opencode-v1",
  "endpoint": { "healthPath": "/global/health", "url": "http://codex-engine:4096" },
  "auth": { "type": "basic", "passwordEnv": "CODEX_PASSWORD" },
  "capabilities": ["sessions", "streaming", "tools"]
}
```

- `protocol` — one of `ENGINE_PROTOCOLS` (`opencode-v1`, `guest-panel`). The
  host rejects unknown protocols outright: a "visible but undrivable" engine
  helps nobody. Adding a protocol means adding driver code, never a string.
- `capabilities` — declared from the closed, versioned vocabulary in
  `capabilities.js`. Unknown ids are dropped with a warning (forward
  compatibility). Declaring `sessions` + `streaming` qualifies the engine for
  the main chat surface; everything else missing is a degradation the UI can
  explain, not "unusable".
- `endpoint.url` — the engine's OWN address. Absent for the built-in opencode
  (it uses the host's single engine address); REQUIRED in practice when
  several engines coexist, or probes and routing cannot tell who is who.
- The built-in opencode descriptor is always in the list unless a file with
  the same id overrides it, so upgrading to this version is zero behavior
  change for existing deployments.

## Active engine

Priority: `OC_ENGINE` environment variable → the single descriptor when there
is exactly one → the built-in opencode. With several external engines present
the built-in keeps serving — alphabetical order must never decide.

Selection by settings field is deliberately absent: the settings registry
(`settings-registry.json`) owns what the UI can persist, and adding an
`engine` field there is a separate product decision (UI + registry + field).

## Surfacing

- `GET /api/openchamber/engines` — descriptor-only snapshot: engine list,
  active engine, parse warnings. `?refresh=1` bypasses the cache. Never
  probes network.
- `GET /api/openchamber/engines/active` — the active descriptor plus one real
  probe (ok/version/latency, cached briefly). `?refresh=1` forces.
- `/health` (additive fields `engine`, `engineRegistry`) — reads the cached
  snapshot synchronously, `null` before warmup. A broken registry is visible,
  not masked by a plausible default.

## Proxy seam

`buildOpenCodeUrl` (network-runtime.js) is the one function the repo asks
"where is the engine" through. When the ACTIVE engine descriptor declares
`endpoint.url`, all engine requests reroute there (late-bound
`resolveActiveEngineUrl`, consulted at request time only, reading caches
only). `null` — no descriptor directory, no declared URL — is byte-for-byte
legacy behavior: routing the way the host always has.

## Fault tolerance

One broken file must not take the registry down: bad files warn and are
skipped, siblings survive, duplicate ids are first-file-wins with a report.
A missing directory is the normal state (no external engines).

The engine lifecycle (spawn/stop of the managed opencode) is NOT touched
here; this module describes, resolves, probes and routes only.

## Files

- `capabilities.js` — the closed capability vocabulary and the chat-surface
  verdict (pure set arithmetic over a parsed list).
- `descriptor.js` — the zod contract for `engine.json`; the built-in
  opencode descriptor; the public API shape.
- `registry.js` — directory load and fault tolerance; active-engine
  resolution.
- `probe.js` — one engine, one question ("alive? which version?"), inputs
  parsed here once.
- `routes.js` — the two HTTP endpoints.
- `index.js` — `createEnginesRuntime`: snapshot + probe caches, the sync
  `/health` hand-off, the proxy seam, route registration.

Deliberately shared-suite tests (these files are one contract): capabilities,
descriptor shapes and rejections, registry fault tolerance, probe behavior,
runtime cache semantics and route handlers.
