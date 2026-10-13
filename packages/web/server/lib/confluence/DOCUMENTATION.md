# Confluence Data Center (self-hosted)

The fork's own read-only client for a self-hosted Confluence Data Center
instance. It exists for one consumer today — the page reader the context
panel's Confluence surface renders — and grows toward attaching a page as
the task brief of a pull analysis or an issue spec along the same REST
surface.

It mirrors the Jira DC module beside it: the same connection shape, the
same card, the same routes' grammar, the same per-instance TLS policy.
The differences are only Confluence's: the token is a Confluence personal
access token, the resource is a page, and the read carries the rendered
HTML Confluence itself renders (`body.view`).

## What it is not

It is not the upstream project machinery: no OAuth, no cookie session, no
multi-instance account book. The connection is one instance, one personal
access token, one TLS policy, written by the Settings → Integrations card
and read by whoever needs the REST API.

## The connection (`config-store.js`)

State persists as `confluence.json` beside jira.json, bitbucket.json and
the rest: `{ version, instance: { origin, token, verifySsl } | null }`.

- `origin` is an HTTPS origin (HTTP is allowed only for loopback
  addresses).
- `token` is a personal access token (Confluence profile → Personal
  Access Tokens → Create token; the request carries
  `Authorization: Bearer`). `readPublic` answers the fact of it, never
  the value.
- `verifySsl` is per-instance, exactly the Jira module's deal.
- The save contract is the saved-secret one: a present field writes, an
  absent `token` keeps the stored one, `''` clears the connection,
  `disconnect: true` drops it.
- Writes move the state first and persist after; a failed disk write
  rolls the state back and throws.

## The routes (`routes.js`)

- `GET /api/openchamber/confluence` — the card's own view.
- `PUT /api/openchamber/confluence` — save. A save that lands a full
  connection is followed by one connection check — a lightweight
  `GET /rest/api/user/current` — and the answer carries
  `connectionCheck: 'ok' | 'unauthorized' | 'unreachable' | …`.
- `DELETE /api/openchamber/confluence` — drop the connection.
- `GET /api/openchamber/confluence/pages/search?q=<words>&limit=<1..25>`
  — the page finder: a CQL text match, pages only, capped at `limit`
  (default 10). The query is sanitized at the search boundary — CQL's
  metacharacters never reach the instance. Answers
  `{ results: [{ id, title, space, lastUpdated, url }] }`.
- `GET /api/openchamber/confluence/pages/view?id=<numeric id>` — one
  page, read whole: `{ id, title, space, version, updatedAt, updatedBy,
  url, html, truncated }`. The `html` is the instance's own rendered
  view, capped at 200 000 characters with the honest `truncated` flag;
  the panel purifies it the way the Jira description's HTML is purified.
  The token stays server-side; the answer carries the view, never the
  connection.

## Failure kinds

The client classifies failures the same way the Jira client does:
`unconfigured`, `unauthorized`, `not-found`, `unreachable`,
`server-error`. The routes map them to the statuses and `kind` fields the
reader words itself; prose parsing is never the client's job.
