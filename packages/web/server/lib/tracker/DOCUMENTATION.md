# Tracker: agent actions on pull requests and issues

The `openchamber_tracker` managed tool: one agent-facing grammar for acting
on the Bitbucket pull requests and Jira issues of the connected instances —
read a pull or an issue, post a comment, approve a pull, list an issue's
workflow transitions, move it through one.

## Why it exists

The bitbucket and jira modules were built read-only: the board's PR chips,
the PR viewer, the issue viewer. The agent had no way to act on the same
entities the user links into a session — a review the agent finished still
needed the user's own hands to post the verdict or approve the pull. This
module adds the write side over the same connections, and both reads and
writes answer through the owning modules' own code.

## Shape

- `tools.js` — the grammar the agent is taught: seven actions (`pr.view`,
  `pr.comment`, `pr.approve`, `issue.view`, `issue.comment`,
  `issue.transitions`, `issue.transition`), three parameters (`ref`, `text`,
  `transition`), and the reference parser: a ref names its entity with
  `pr://<full Bitbucket pull-request URL>` or
  `issue://<Jira browse URL or bare issue key>`; the plain URL or key parses
  the same way. The scheme is stripped here and the owning modules' parsers
  keep the honesty about what they accept.
- `service.js` — the one executor. Per action: parse the ref, read the
  configured connection (per call, never cached), refuse a ref of another
  instance explicitly, then call the owning module. Reads go through
  `readPullView` / `readJiraIssueView` — the agent sees the same view the
  user's panels do. Writes go through the clients' mutation factories
  (`createBitbucketMutation`, `createJiraMutation`): a comment or an
  approval goes out under the configured user's own token and name, never
  the agent's.

The tool ships always, like the team tool: without a configured connection
every action answers `unconfigured` (a usage-grade error naming the
settings card), so there is nothing to gate — and with one, the user has
already handed over the credentials the actions run under. Every call is
visible in the chat as a tool call with its full input.

## Error grades

The service throws `TrackerError` with a statusCode the agent tool reads:
4xx answers `usage` (a bad ref, empty text, a transition that does not
exist, an unconfigured connection) and 5xx answers `runtime` (transport
trouble, an instance that answered 5xx). The client's own kinds map onto
the same grades, and a 400/409 carries the instance's own message when it
parsed — the agent quotes rather than invents.

## REST surface

Bitbucket Data Center 1.0: `POST .../pull-requests/{id}/comments` with
`{text}`; `POST .../pull-requests/{id}/approve` with no body (a 409 carries
the instance's own reason — approving your own pull, approving twice).
Jira 2: `POST /rest/api/2/issue/{key}/comment` with `{body}`;
`GET`/`POST /rest/api/2/issue/{key}/transitions` — the GET resolves a name
to an id and names what exists on a miss, the POST applies it.

## Tests

`tools.test.js` pins the grammar and the reference forms (schemes, bare
URLs, everything that is not an entity reads back null). `service.test.js`
pins dispatch: the configured-connection flow per action, the comment cap
and trim, unconfigured and wrong-instance answers, the client-failure
grades, transition resolution by id and name, the listing on a miss. The
agent tool's dispatch tests live in `agent-tool/runtime.test.js`.
