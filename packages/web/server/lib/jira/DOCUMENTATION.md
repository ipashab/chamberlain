# Jira Data Center (self-hosted)

The fork's own read-only client for a self-hosted Jira Data Center
instance. It exists for one consumer today — the issue viewer the context
panel's Jira surface renders — and grows toward the ask flow and the
issue analysis along the same REST surface.

It mirrors the Bitbucket DC module beside it: the same connection shape,
the same card, the same routes' grammar, the same per-instance TLS policy.
The differences are only Jira's: the token is a Jira personal access
token, the resource is an issue, and the read carries the rendered HTML
Jira itself renders.

## What it is not

It is not the upstream project machinery: no OAuth, no cookie session, no
multi-instance account book. The connection is one instance, one personal
access token, one TLS policy, written by the Settings → Integrations card
and read by whoever needs the REST API.

## The connection (`config-store.js`)

State persists as `jira.json` beside bitbucket.json and the rest:
`{ version, instance: { origin, token, verifySsl } | null }`.

- `origin` is an HTTPS origin (HTTP is allowed only for loopback
  addresses). Instances behind a reverse proxy keep their context path in
  the browse URLs, not in the origin — a browse URL with a context path of
  another deployment reads back `wrong-instance`, not a silent read.
- `token` is a personal access token (Jira profile → Personal Access
  Tokens → Create token; the request carries `Authorization: Bearer`).
  `readPublic` answers the fact of it, never the value; the card and every
  route answer `{ configured, origin?, hasToken?, verifySsl? }`.
- `verifySsl` is per-instance: corporate instances often sit behind a
  self-signed certificate, and the request carries the instance's own
  `rejectUnauthorized` instead of weakening the process.
- The save contract: fields are independent, a present field writes, an
  absent `token` keeps the stored one, `''` clears the connection,
  `disconnect: true` drops it. The body is parsed at the store's boundary;
  junk that does not fit the schema answers 400.
- Writes move the state first and persist after: the read that follows a
  save sees the save, and a failed disk write rolls the state back and
  throws.

## The routes (`routes.js`)

- `GET /api/openchamber/jira` — the card's own view.
- `PUT /api/openchamber/jira` — save. A save that lands a full connection
  (origin + token, whether fresh or kept) is followed by one connection
  check — a lightweight `GET /rest/api/2/myself` — and the answer carries
  `connectionCheck: 'ok' | 'unauthorized' | 'unreachable' | …`, so a
  rejected token says so on the card, at the moment it is pasted. Saves
  without a full connection skip the check.
- `DELETE /api/openchamber/jira` — drop the connection.
- `GET /api/openchamber/jira/issues/search?q=<words>&limit=<1..25>` — the
  quick finder: a text match of the words (or an exact-key look-up when
  the query itself is an issue key), newest by update, capped at `limit`
  (default 10). The query is sanitized at the search boundary — JQL's
  metacharacters never reach the instance. The same error kinds as the
  view answer failures.
- `GET /api/openchamber/jira/issues/view?ref=<browse URL | issue key>` —
  the issue viewer's read: the issue's whole view, assembled by
  `issue-view.js` from the issue GET, the watchers page, and the epic's
  own GET when an Epic Link names one. The errors are kinds the viewer
  words itself: `bad-ref` (400) when the reference is neither a browse
  address nor an issue key, `unconfigured` (409) with no connection,
  `wrong-instance` (409) when a full URL belongs to another instance or a
  context-path deployment — its coordinates never travel to the
  configured one — `not-found` (404), and `unauthorized` /
  `unreachable` (502) carried from the client. The success body never
  mentions the connection; the token stays server-side.
- `GET /api/openchamber/jira/avatar?path=<instance image path>` — the
  instance's own avatar and icon bytes, proxied with the stored token:
  the browser never holds one, and only the instance's own image paths
  (`/secure/useravatar`, `/secure/viewavatar`, `/images/`) are served;
  anything else is refused (400) before any request. The answer is the
  image itself with its content type (short-lived private caching);
  unconfigured answers 409, and an instance that has no such image
  answers 404 with no body — the drawing side reads any failure as its
  initials fallback. Still a read: one GET, no other verb.

## The client (`client.js`)

One authenticated GET per resource over `node:https`/`node:http`, Bearer
token, per-instance TLS policy, 15s timeout, JSON parsed and returned
(`createJiraRequest`); one image/byte variant for the avatar proxy
(`createJiraAvatarRequest`). Failures classify into `JiraError` kinds the
callers branch on: `unconfigured`, `unauthorized` (401/403), `not-found`
(404), `unreachable` (transport and TLS), `server-error` (everything
else, including a body that is not the JSON the caller asked for).

## The reference grammar (`url.js`)

Two forms, one parse:

- `https://<origin>[/<context path>]/browse/<KEY>` — the full address,
  with origin and context captured so another instance's URL can be
  refused by name.
- `<KEY>` bare — an issue of the configured instance (the parse answers
  `origin: null`, and only the route knows the configured one).

The key grammar is `[A-Z][A-Z0-9]{0,9}-<number>` — `JIRA_ISSUE_KEY_PATTERN`
is the same pattern the composer's issue auto-detect reads. The parse also
rebuilds the canonical URL from the parts; a hand-edited alias never
reaches the API.

## The issue view (`issue-view.js`)

The issue viewer's read, from up to three GETs to the issue's own
resources:

- The issue itself — `/rest/api/2/issue/<key>?expand=renderedFields,names`
  — carries the details (type, status with its category, priority,
  resolution, people, dates, labels, components, versions, watch count),
  the description twice (wiki markup and rendered HTML), the comments
  with their rendered bodies matched by id, the issue links, the subtasks,
  the attachments, and the `names` map that identifies the custom fields.
- The watchers page names the crowd when the token's account may see it;
  permission-walled, the view degrades — the count stays, the names
  answer null. No viewer fails because it cannot name the crowd.
- An Epic Link that names an issue key is followed by that epic's own
  GET (summary and status); a failure degrades to the key alone.

Custom fields are read through the `names` map, and only a field whose
value parses as a display shape (text, number, option, or a list of
those) answers a row — the values Jira's own detail column would show as
text. The Epic Link and Sprint fields additionally land in their
dedicated `epic` and `sprints` places, because the viewer and the ask
flow reason about them by role, not by label. Fields that don't parse —
a user picker, a rich extension — are skipped, not guessed into prose.

`truncated.comments` reports a `total` larger than the comments array
the instance sent — the honest admission the same shape the Bitbucket
view carries. The description's rendered HTML answers null when the
instance renders nothing, and the UI falls back to the raw markup as
text.

Local processing is the point: everything the viewer and the chat's
"ask about this issue" quote carry is assembled on the user's machine
from GETs to the issue's own resources. The instance receives nothing
back — the request module has GET as its only verb.

## The search (`issue-search.js`)

The quick finder's read, one GET: the query's plain words as
`text ~ "<words>*"` — the same quick search Jira's own header runs — or
an exact-key look-up first when the query itself is an issue key, ordered
by the last update, capped at the caller's limit. The sanitizing happens
at this boundary because JQL is a language: JQL metacharacters are
dropped before the words reach the instance. Rows without a key are
dropped, not guessed.
