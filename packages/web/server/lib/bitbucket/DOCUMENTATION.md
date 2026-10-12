# Bitbucket Data Center (self-hosted)

The fork's own read-only client for a self-hosted Bitbucket Data Center
instance. It exists for one consumer today — the team board's PR chips — and
grows toward the PR viewer along the same REST surface.

## What it is not

It is not the upstream source-control machinery: no OAuth device flow, no
credential file lock, no multi-instance account book. The connection is one
instance, one personal access token, one TLS policy, written by the Settings
→ Integrations card and read by whoever needs the REST API.

## The connection (`config-store.js`)

State persists as `bitbucket.json` beside teams.json and missions.json:
`{ version, instance: { origin, token, verifySsl } | null }`.

- `origin` is an HTTPS origin (HTTP is allowed only for loopback addresses).
  Instances behind a reverse proxy keep their context path in the pull URLs,
  not in the origin.
- `token` is a personal access token. `readPublic` answers the fact of it,
  never the value; the card and every route answer `{ configured, origin?,
  hasToken?, verifySsl? }`.
- `verifySsl` is per-instance: corporate instances often sit behind a
  self-signed certificate, and the request carries the instance's own
  `rejectUnauthorized` instead of weakening the process.
- The save contract: fields are independent, a present field writes, an
  absent `token` keeps the stored one, `''` clears the connection,
  `disconnect: true` drops it. The body is parsed at the store's boundary;
  junk that does not fit the schema answers 400.
- Writes move the state first and persist after: the read that follows a
  save sees the save, and a failed disk write rolls the state back and throws.

## The routes (`routes.js`)

- `GET /api/openchamber/bitbucket` — the card's own view.
- `PUT /api/openchamber/bitbucket` — save. A save that lands a full
  connection (origin + token, whether fresh or kept) is followed by one
  connection check — a lightweight `GET /rest/api/1.0/projects?limit=1` —
  and the answer carries `connectionCheck: 'ok' | 'unauthorized' |
  'unreachable' | …`, so a rejected token says so on the card, at the
  moment it is pasted. Saves without a full connection skip the check.
- `DELETE /api/openchamber/bitbucket` — drop the connection.
- `GET /api/openchamber/bitbucket/pulls?limit=<1..25>` — the pull surface's
  landing list: the open pulls of the token's own dashboard, newest activity
  first, capped at `limit` (default 10). The answer carries `truncated`,
  an honest admission that the dashboard held more open pulls than the cap
  let the walk collect. The same error kinds as the view answer failures.
- `GET /api/openchamber/bitbucket/pulls/view?url=<pull request URL>` —
  the PR viewer's read: the pull's whole view, assembled by
  `pull-view.js` from four GETs plus the activities pages. The errors
  are kinds the viewer words itself: `bad-url` (400) when the link is
  not a pull address, `unconfigured` (409) with no connection,
  `wrong-instance` (409) when the pull belongs to another instance or a
  context-path deployment — its coordinates never travel to the
  configured one — `not-found` (404), and `unauthorized` /
  `unreachable` (502) carried from the client. The success body never
  mentions the connection; the token stays server-side.
- `GET /api/openchamber/bitbucket/pulls/avatar?slug=<user>&size=<32|48|64>` —
  one user's avatar, the bytes proxied with the stored token: the browser
  never holds one, and the URL a slug could forge is refused (400) before
  any request. `size` defaults to 48; any other size reads back as the
  default. The answer is the image itself (`image/png`, short-lived
  private caching); unconfigured answers 409, and an instance that has no
  such avatar answers 404 with no body — the drawing side reads any
  failure as its initials fallback. Still a read: one GET, no other verb.

## The client (`client.js`)

One authenticated GET per resource over `node:https`/`node:http`, Bearer
token, per-instance TLS policy, 15s timeout, JSON parsed and returned.
Failures classify into `BitbucketError` kinds the callers branch on:
`unconfigured`, `unauthorized` (401/403), `not-found` (404), `unreachable`
(transport and TLS), `server-error` (everything else, including a body that
is not the JSON the caller asked for).

## The URL grammar (`url.js`)

One pull address shape:
`https://<origin>[/<context path>]/projects/<project>/repos/<slug>/pull-requests/<id>`.
The parse answers origin, context, project, slug, number and the canonical
URL rebuilt from the parts — a hand-edited alias never reaches the API. It is
pure: no fetch, no state. `bitbucketPullCacheKey` is the summary cache's
identity (origin + context + coordinates), shared by the board reader.

## The summary (`pull-summary.js`)

DC answers mapped into the team board's summary contract — the same shape the
GitHub layer produces — so the chip renders both providers through one client
schema. Mapping decisions, kept honest rather than guessed:

- state: OPEN → `open`, MERGED → `merged`, DECLINED (and anything unknown)
  → `closed`.
- draft: DC has no draft flag (that is a Cloud concept) — always false.
- mergeable: DC computes conflicts only on a merge dry run the read never
  makes — `null`, unknown, the same value GitHub answers while computing.
- checks: the rollup reads the fromRef's latest commit's build statuses.
  Any FAILED → `failure`; else any INPROGRESS → `pending`; only all
  SUCCESSFUL → `success`; none or anything unrecognized → `unknown`.

Bodies parse through zod at this boundary; a body that does not answer the
expected shape is a `server-error`, not a silent defaults read.

Refs whose origin or context differ from the configured instance's resolve
to `null` — unknown — rather than being read: the coordinates of one
instance never travel to another (see the pull view route's
`wrong-instance` for the viewer's version of the same rule).

## The pull view (`pull-view.js`)

The PR viewer's read: one pull's meta (title, description, state, author
with its avatar slug, branches, reviewers with approvals), its checks — the
same rollup as the chip's summary — its commits (one page, summary lines
only, the first `truncated` flag counting them), the changed files each
carrying a unified patch rebuilt locally from DC's JSON diff, and the
comments from the activities pages (replies inside, threads newest-capped
at three pages, `COMMENTS` only; approvals live in the meta's reviewers).
People carry both words and handles: every author field travels beside its
`authorSlug` — the instance's stable handle the avatar proxy builds its
URL from; a person the instance did not name by slug reads back null.

Local processing is the point: everything the viewer and the chat's
"ask about this pull request" quote carry is assembled on the user's
machine from GETs to the pull's own resources. The instance receives
nothing back — the request module has GET as its only verb.

Diff representation: DC answers a diff as JSON files with hunks of
`CONTEXT`/`ADDED`/`REMOVED` segments. The unified patch text
(`diff --git`, `---`/`+++`, `@@ -line,span +line,span @@`, prefixed lines)
is rebuilt here because that is the one diff form both consumers — the
viewer and the chat material — read. The JSON never leaves this module.

## The open pulls list (`pull-list.js`)

The pull surface's landing list: the token's own dashboard — the pulls
the account authored or reviews — read through paged GETs, kept to the
open ones in the order DC orders them (recent activity), capped at the
caller's limit. The pull's URL number is its `id` on this instance: the
dashboard bodies carry no displayId and the web UI opens pulls by id,
so the id is the number a user knows the pull by. Rows without repo
coordinates are dropped, not guessed. `truncated` says the walk stopped
before the dashboard emptied of open pulls; a closed pull never lands
in the list, so the list is never mistaken for the whole account.

## The consumer (`team/pull-status.js`)

The board's chip reader splits each task's pull by provider: GitHub refs
flow through the existing GraphQL layer unchanged; Bitbucket refs come here.
A board of only GitHub pulls answers exactly what it answered before
Bitbucket existed; a board with Bitbucket pulls never asks GitHub for them;
one provider failing on a mixed board leaves its own tasks unknown and the
other's live. No configured connection means unknown Bitbucket chips and no
cached nulls — the event after the card saves a token goes live at once.
