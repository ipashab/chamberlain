# MCP Console

## Shape

The console answers "what tools do my MCP servers carry, and what happens
if I call one" without an agent in between. One server-side module holds
one live connection per configured server of the scoped OpenCode config
(the same layers the MCP settings section edits: project, user override,
user), adopted on first use and retired by an idle timer.

- Config access: `lib/opencode/mcp.js` — `getMcpConfig(name, cwd)`,
  `listMcpConfigs(cwd)`; the same entries the agent runs with, including
  `disabled` and `codemode` flags.
- Wire: `protocol.js` (pure framing) and `client.js` (transports). Local
  servers spawn by `command` and speak newline-delimited JSON-RPC on stdio;
  remote servers answer one POST per request over streamable HTTP — plain
  JSON or SSE, session id from the initialize response riding along. SSE
  events end at a blank line framed with LF or CRLF: uvicorn and starlette
  (FastMCP's stack) send CRLF, and reading only LF loses every event.
- Lifetime: `service.js` — per-(directory, server) registry; the in-flight
  handshake is shared, a catalog caches until its connection retires, and
  an idle timer (15 minutes) closes what nobody asked for.

## Routes

- `GET /api/openchamber/mcp-console/servers` → `{ servers: [...] }` — every
  configured server: `{ name, type, scope, disabled, codemode, local:
  { command }, remote: { origin }, needsAuth, console: { connected,
  toolsKnown } }`. Secrets (`environment`, `headers`, URL credentials)
  never appear; a remote entry shows only its origin.
- `GET /api/openchamber/mcp-console/servers/:name/tools` →
  `{ server, tools: [{ name, description, inputSchema }] }` — the catalog,
  `tools/list` pages walked to the end, cached per connection.
- `POST /api/openchamber/mcp-console/servers/:name/call` —
  `{ tool, arguments? }` → `{ server, tool, durationMs, result: { isError,
  text, contentTypes, nonTextItems, structured } }`. Text content joins
  into `text`; non-text items are counted and named, not shipped whole.

The scoping directory arrives the way every fork route takes it: the
`x-opencode-directory` header (set by the UI's runtimeFetch) or a
`directory` query parameter.

## Contracts

**Errors** are `McpConsoleError` with an HTTP status: `400` bad input or an
entry the console cannot serve (a remote server whose auth is an OAuth
flow — that handshake belongs to OpenCode's connection), `404` no such
server or no such tool, `502` the server died or answered nonsense,
`504` it did not answer in the configured phase timeout. A local server
that dies during the handshake carries its stderr tail as `diagnostics`
— often the only thing a silently broken spawn leaves behind.

**Timeouts** come from the entry's own `mcp.timeout` config when set
(`startup`, `catalog`, `execution`); the defaults are 20 s, 30 s and 120 s.

**Trust**: these routes run the user's own configured servers, the same
trust level as the agent's tool calls; nothing here reaches beyond servers
the config names, and the console adds no mutation path the tools
themselves do not have.

## Limits (deliberate)

- One console connection per (directory, server): a second spawned stdio
  server instance is an independent process, so tool state does not mix
  with the agent's own connection to the same server; long-running tools
  hold their connection open, and a call answers before the next starts.
- No subscriptions (`notifications/tools/list_changed` updates the
  server's own news only for its peers), no resources, no prompts, no
  sampling: catalogs refresh when the idle timer retires the connection.
- Remote entries use streamable HTTP only; legacy SSE-and-endpoint remotes
  answer `400` at connect time.
- No streaming answers to the panel: one request, one response, the
  route's own execution timeout.
