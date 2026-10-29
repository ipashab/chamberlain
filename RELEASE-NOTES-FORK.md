# OpenChamber fork release notes

**Base:** upstream `openchamber/openchamber` @ `95af6769` (v2.5.3), merged
whole. The fork numbers its own patches on top with the `forkN` marker —
`2.5.3-fork1` on `v2.5.3`, `2.5.2-fork1` on `v2.5.2`, and before that
`2.5.0-forkN` on `2.5.0` (`ad73d11a6`, merged whole in `594d0d09f`), then
earlier tags below. Each release's notes below carry only that release's
changes; `fork1` sections are that base's whole fork delta, so their
base-move section names the upstream highlights and the release's own
section the fork's work. The upstream releases' own notes live whole in
`changelog/` — `2.5.3.md`, `2.5.2.md`, `2.5.1.md` and down.

---

## `2.5.3-fork1` — upstream `2.5.3` whole: snippets, pictures, agents that wait

**The base moves to upstream `v2.5.3`.** **Snippets**: save a message, a
piece of selected text or a draft as a snippet from its menu or the `#`
picker, and rename, move and preview them in Settings. Agents can
**generate images** — a second model of the user's choosing in Settings,
off by default and costing its own money while on. **Auto-review** keeps
going with the tab closed or the phone locked, stops after five rounds
and notifies once. An agent can now **wait on its pull request**
(`pr.watch`): it wakes when a check fails or passes, someone comments or
reviews, the branch conflicts or falls behind, or it merges or closes —
never with a sleep loop — and the composer shows the watched PR with a
Stop watching control. Header tabs can keep a tab per project and
worktree, a worktree can be **pinned** to the top of the sidebar, and
worktree rows can lead with the branch name. A running session in a busy
folder no longer sends about a gigabyte an hour to OpenCode, the vendored
git library moves past four CVEs, provider connections work on the first
try, and GitHub Enterprise and self-hosted GitLab behind a company
certificate connect. OpenCode `2.2.0` is the oldest the app runs against
now. Upstream's own notes are whole in `changelog/2.5.3.md`.

**The fork keeps its face.** The splash screen and app icons stay the
Arch Monogram set. The team board, the backlog strip, checkpoints, the
advisor, the debugger tool, the tracker and contacts, and the board's MR
wording for GitLab repositories all moved onto the new base unchanged;
upstream's new surfaces — the snippet picker, the PR-watch row, the
image tool — were wired into the fork's layout tree rather than the
reverse. The composer's top row now carries the fork's backlog strip and
upstream's PR-watch row side by side, the settings registry lists the
fork's debugger flag beside the new image tool, and the plugin
materialization ships both in one source.

**The card measures the way upstream measures.** The work-status card's
room measure adopts upstream's mechanics — width the panel was resized
to, roomy beside the panel — while measuring what the fork's layout
actually renders: the workspace row. A context-panel entry that carries
the fork's layout tree answers from the tree; one that does not answers
by its own open flag, with an open panel holding no tab displacing
nothing either way.

**The tag shipped stale against itself.** Upstream's release relabeled
the diff header's open-in-editor button and the plan actions — an
aria-labeled shared toolbar, Improve and Implement — but left its own
tests hunting the old buttons; upstream repaired those selectors after
the tag and the same repair lands here. The fork's always-on tools
(team, tracker, contacts, backlog) are counted in upstream's new
image-tool test, the control tool carries the upstream `pr.watch` and
`pr.unwatch` waits beside the tracker's Bitbucket and Jira grammar, and
the tracked menu gained the Russian line for upstream's new Suggest a
Feature entry.

**Russian catches up again.** The isolated-spaces surface gained a dozen
new Russian strings, and about thirty keys upstream deleted between
releases were swept out of the Russian dictionaries — the ru fallback
reads English for anything still untranslated, and the easter-egg
jokes stay in English for the Russian locale rather than dropping it.

## `2.5.2-fork1` — upstream `2.5.2` whole: works in the sidebar

**The base moves to upstream `v2.5.2`, and two upstream releases land at
once.** `2.5.1` is "tea time for git": Gitea, Forgejo and Gerrit join
GitHub and Bitbucket/GitLab as git hosts, pull requests stack, and usage
limits can carry a session to the provider's next account or a fallback
model. `2.5.2` redraws the sidebar around **works** — a worktree with all
its sessions, or a session in the main checkout with its forks, reviews
and subagents, as one row named by its task — adds **folder trust** (the
app shows what a folder's own plugins, MCP servers and commands would run
and asks before they do), GitHub Discussions beside issues and PRs,
`@`-mentions of other sessions in the composer, per-project Magic Prompts,
a diagnostics memory snapshot, and archiving that keeps a worktree's
branch and sessions while dropping its folder. Upstream's own notes are
whole in `changelog/2.5.1.md` and `changelog/2.5.2.md`.

**The fork keeps its face.** The splash screen and app icons stay the
Arch Monogram set — the brand generator no longer lists `early-startup.mjs`
among the files it may overwrite. The team board, session-group presets,
the debugger tool, the Bitbucket pull view in the team board, and the
board's MR wording for GitLab repositories all moved onto the new base
unchanged; each new upstream surface (the workflows tab among them) was
wired into the fork's context-panel layout tree rather than the reverse.

**Zone widths persist the upstream way.** The context panel's zone sizes
now persist as upstream's v26 store model (`contextZoneSizes`) under the
fork's layout; a v25 (or older) store migrates on first start. Three of
upstream's own tagged tests were stale against their own release — the
telemetry migration expected store version 25 while the store is 26, and
the settings registry never listed the newly persisted key — and the
merge stitching doubled one brace in the managed-config builder; all
four are corrected here, with the fork's own tool flags folded into the
tests upstream added.

**Russian catches most of the new keys.** The upstream releases brought
about seventy new interface strings. The reference picker, the source
board and the git-host rail descriptions got Russian translations, and
the ru dictionary now falls back to the English entry for anything it
does not translate itself — the handful that missed this pass read in
English until the next one.

## `2.5.0-fork8` — a face per person, on every surface

**Avatars load in the desktop app.** A picture of a comment's author was a
relative `/api/openchamber/...` path in an `img` element. On the web surface
the server serves that document, so the path resolves. The packaged app loads
its own shell scheme and answers every runtime path there with `503`, so the
bytes never arrived and the circle fell back to initials. Jira people were
drawn the same way and went missing the same way. Both now ask the runtime
URL resolver for the address, which yields a relative path on the web surface
and an absolute one pointing at the runtime server elsewhere. An `img` cannot
attach an authorization header, so the two avatar routes joined the short list
of reads a scoped URL token may open.

**Every reply carries its author's circle.** A thread drew the picture only on
its root comment, and the replies below were bare names. Now each level gets
its own circle, the same one that person has in every other list.

**About reports the fork's version.** That dialog reads the version from the
`@openchamber/web` manifest, and the `forkN` bumps were moving two manifests
out of six, so it kept reporting an older number while the app itself was
already newer. The release bump now moves all six together.

One limit worth naming: a Data Center instance may serve a personal picture
only to a request carrying a browser session cookie, and answer a token
request with its built-in placeholder. That placeholder is what shows there.
Nothing to do about it from a token-only client.

---

## `2.5.0-fork7` — the comment's code window in the quote's format

**One code format in the pull viewer.** An anchored comment carries a window
of the lines it talks about, and that window used to draw smaller and denser
than a fenced block of the comment's own text: 11px rows, tight leading, a
plain border with no fill. It now draws the way the fenced block draws. A
rounded card on the elevated surface, the file's language in a header line,
`--text-code` type at the markdown code line height, and a two-rem number
gutter with a hairline rule and tabular figures. The diff keeps its own
signals, so the plus and minus signs, the added and removed row tints and the
selection band on the anchored line all stay, and the colors still come from
the whole-file worker pass the Changes tab pays for.

---

## `2.5.0-fork6` — threads with depth, an arch for a seal

**Nested PR replies render.** Data Center nests a comment thread
arbitrarily deep — the instance reports no `parentId` on nested replies,
so the tree is the only witness of who answers whom. The pull viewer read
one level of `comment.comments` and dropped the rest; now the whole tree
walks through the mapper, the client schema and the card, every level one
indent deeper. The ask on a nested reply names the reply it answers, not
the thread's root, and the quote material and the analysis reading carry
the depth with `>` markers. Replies keep their `id`, so the thread keys
stay stable.

**A new Chamberlain icon.** The brass seal with the key on teal wax is
retired for a drawn-in-vector arch monogram: a blue arch on a deep navy
squircle, with light and dark variants for the asset catalog
(`AppIcon.icon` rebuilt through actool). The `package-beta` flavor no
longer draws its icon from an inline Pillow pass — it copies whatever
the fork's stock icons carry, so the next icon change is a file swap.

## `2.5.0-fork5` — a backlog you can reorder

**Rows that move, one order everywhere.** The backlog strip's expanded
list now changes the run order: a grip drags a row to a new place (dnd-kit
with the queue strip's sensors: mouse after a small move, touch after a
long press), and arrows walk a row one place at a time, disabled past each
row's boundary. Every move is one graded `backlog.move` through the store,
and the broadcast brings the new order back to every window before the
rows redraw, so two windows keep agreeing on the queue — the same
invariant the strip's counts already live by.

**Positions in the file, not rewritten timestamps.** The store stamps every
record it persists with an explicit `position` and sorts by it on read,
falling back to the timestamp for records that carry none. A file from
before the first move reads in its old chronological order; a record staged
after a reorder lands behind the reordered ones, newest last. The reorder
is honest across restarts.

**The agent can reorder too.** The `openchamber_backlog` tool gains
`backlog.move` (itemID + position), so "передвинь ревью в начало очереди"
works in chat as well as in the strip.

---

## `2.5.0-fork4` — the stage button, one strip per composer, honest counts

**A button that stages the draft.** Beside the composer's send button, a
"stage to queue" action moves the current draft verbatim into the session
backlog — one click, the draft is queued, the composer is clear, and a toast
says where it went. Slash-command drafts are refused with a toast instead of
staging, and the button appears only when a session is bound and the draft
carries text. Every one of the sixteen locales carries its strings, in the
fork's parity tests.

**The queue every window agrees on.** The backlog broadcast left the server
with its frame in the wrong shape, so other windows never refetched and the
 strip over the composer could sit on a stale count until its own window
staged something. The frame now travels as the one envelope the client
matches, pinned by a regression test.

**One strip per composer, not one per re-render.** `BacklogStrip` and
`BackgroundShellsStrip` are siblings in the composer's top rows, and both
were keyed by the bare session id — React read them as duplicate keys, which
is an unsupported mode that *duplicates children*: every re-render of the
composer mounted one more frozen copy of the strip, and over a long session
the copies covered the chat. The keys are now namespaced per component
(`background-shells:`/`backlog:` + session id), keeping the swap-on-session-
change behavior they were keyed for.

**The goal knows where the follow-ups go.** The goal-mode reminder now tells
the agent that one goal runs per session and prompts the user stages further
belong on the session backlog (`openchamber_backlog` `backlog.add`), each
running as its own turn after the goal.

---

## `2.5.0-fork3` — contacts, the session backlog, full tool descriptions

**Delegating to the saved contacts.** `openchamber_contacts`, a managed
tool grammar over the contacts list: `contact.list` shows who exists;
`contact.run` hands the task to a contact by forking the calling
session under the contact's model and agent, context riding along;
`contact.wait` follows the child session until the contact's first
answer lands, or its turn ends without one. The caller's session id
rides under its own name, so `wait`'s sessionID, the child the run
returned, is never trampled. Contract in
`packages/web/server/lib/contact-run/`.

**A queue for the work not started yet.** `openchamber_backlog`, a
per-session queue the agent fills from the chat itself: add, list,
remove, clear, and a `backlog.run` that starts a watched drain — each
staged item goes out as its own turn, in order, and a refusal stops
the queue with the rest still staged. A strip over the composer shows
the queue, runs it and clears it; all sixteen locales carry its
strings, in the fork's parity tests. Contract in
`packages/web/server/lib/session-backlog/`.

**Tool runs carry their descriptions.** The MCP console's run frame
renders the tool's full description above its schema, so a long help
text reads where the run happens.

---

## `2.5.0-fork2` — the advisor, turn checkpoints, the tracker, the debug tool

**A turn's work, reviewed where it lands.** After a turn that changed
files, the server re-reads what the turn edited, checks the diff against
its own rules and asks the small model what it finds; the findings
render under the answer, in the chat itself. A settings row switches
the advisor off entirely. Contract in
`packages/web/server/lib/advisor/`.

**Put a turn's files back.** A session that turns busy pins its whole
worktree as one tree through a throwaway index; when the turn touched
files, the registry records which. Each user row then offers to put
those files back to how they stood before the turn — the conversation
stays where it is — and a second action undoes the restore. Ignored
files are never deleted, evicted entries hand their refs back, and one
level of undo is the honest limit. Contract in
`packages/web/server/lib/checkpoints/`.

**Acting on pulls and issues, from the chat.** `openchamber_tracker`,
a managed tool grammar for the connected Bitbucket pulls and Jira
issues: comment, reply to review threads, transition, merge, with read
shapes widened to match. Contract in
`packages/web/server/lib/tracker/`.

**Debug runs as the agent's own tool.** Driving a debugpy run is a
distinct intent with its own vocabulary (`agentDebuggerToolEnabled`):
start, wait for the stop or the exit, read the state, set breakpoints,
continue, stop. The panel and the agent share the single session, so a
watched panel shows the agent's run live. Actions in
`packages/web/server/lib/openchamber-control/debugger-actions.js`.

---

## `2.5.0-fork1` — the MCP console, and upstream's warm sessions

**Every MCP server's tools, one console.** A new surface in the right
rail lists the scope's MCP servers, one server's tools, and a catalog of
every tool across servers with a filter. The run form shows a tool's
schema, its result and how long the call took, and it is keep-alive, so
switching tabs keeps an answer on screen. It opens from the rail, from
the two palette commands, and from the MCP cards in Settings, which
deep-link to the server's tools. The server side connects each
configured server once and marks only a dead server's own catalog line,
and its SSE reader normalizes the CRLF framing uvicorn emits. Contract
in `packages/web/server/lib/mcp-console/`.

**The tray reaches the web UI.** The loopback server picks a fresh port
on every run, so the browser cannot hold a bookmark to it; the tray
carries an item that opens today's port in the system browser, and is
skipped silently before one exists.

**A debug run's children join it.** debugpy offers each spawned child as
a `debugpyAttach` event; the service adopts it as a second DAP session
over the adapter's client socket and attaches by `subProcessId`.
Breakpoints mirror to every live channel, the child's output folds into
the same tail, and a stop from any channel routes the panel's control
commands to that channel. A child's exit closes only its channel; the
verdict stays with the root process.

**Upstream `2.5.0` whole**: find-in-changes over the whole changeset,
"Annotate page" on pages a chat agent shows, sessions kept warm after a
reply, the crash-in-a-row recovery that reloads without the saved
layout, a chat that stays responsive across hours of work, and Electron
44 with macOS 13 as the floor. The full list is `changelog/2.5.0.md`.

The fork's sixteenth locale (Russian) carries every new string of the
merge: the chat and settings keys, find-in-changes, session notices and
session warming, all in the fork's parity tests.

---

## `2.4.0-fork3` — three ways to sit down to the work

**The window has a mode switcher now.** The header names one of three
arrangements: **Chat** holds the main area with surfaces beside it,
**Debug** seats the editor above the debug panel, **Overview** hands the
main area to issues and pull requests and keeps the chat a side column.
Every project remembers a layout tree per mode — switching modes never
drops a tab — and entering a mode rebuilds the named regions it is
answerable for: close the files area, leave debug, come back, and the
editor is where you left it. A debug run started from chat, and a
tracker item opened there, each offer their mode once as a dismissible
card; every mode takes a shortcut.

**The team's board answers with the fork's own tools.** The board is two
tabs over the real Bitbucket and Jira panels — one board, two whole
surfaces, both entrances drawing one source of truth. The issues tab
lands on the account's own unfinished work: a server-owned my query
(`/api/openchamber/jira/issues/my`) reads the token's open issues,
newest first — the board opens on what needs you, not on a search box.

**A pull's changes read like the files view.** In a host wide enough the
folder tree pins the left side — single-child folder chains fold, rows
carry counts and state badges — and the picked file opens whole to its
right, the diff scrolling while the tree stays. Picking another file
moves the reading pane, not the tree. A narrow host keeps the inline
tree as before.

All strings ship in every locale the app carries. The mode layouts are
documented in `packages/ui/src/lib/workspace/DOCUMENTATION.md`, the
surfaces they route in `lib/surfaces`, and the new route in the Jira
server contract.

## `2.4.0-fork2` — Python debugging, where the code already is

Debugging a Python test used to mean leaving the app: PyCharm for
breakpoints, or prints and a scroll of output. This release brings the
debugger to the editor.

**Breakpoints and run arrows in the gutter.** In a `.py` file the strip
left of the line numbers takes a click: a breakpoint appears where you
clicked. Top-level defs grow a run arrow; a script runs as itself, a
test runs under pytest with its node id. The configured breakpoints ride
along with every launch.

**A debug panel that answers one DAP session.** The panel splits in
beside the most recently touched tab. It shows the stack with the
current frame, steps over, into and out, continues and stops. Variables
are a tree with values, a copy action and a share action that attaches
the variable to the chat, framed for the model with the dotted path,
the adapter's type and where the debuggee stopped. An evaluate field
runs an expression in the stopped frame. Output streams live, and a
pytest reporter folds collected nodes, per-test status and tracebacks
into the run's exit log.

**The interpreter is a setting.** Settings → Python debug names the
interpreter the panel launches with; empty lets each project's own
`.venv` win. The run lives and dies with its process, and nothing
persists between server starts.

**One small thing beside it:** a file tab's context menu can copy the
full path the tab stands for.

All strings translated in every shipped locale. The server contract:
`packages/web/server/lib/debugger/DOCUMENTATION.md`.

## Base move to upstream `2.3.1`

The whole of upstream `2.3.0` and `2.3.1` is merged in, with every fork
feature kept. What the merge brought and where the fork met it:

- **Zones and movable panels** — surfaces now live in `left` / `right` /
  `bottom` zones around the chat, drag-and-drop and resizable from the edge.
  The fork's Bitbucket / Jira / Confluence / review / team surfaces ride the
  new keep-alive panes as remount surfaces and register with the unified
  default-width scheme.
- **Sorted mode is gone; live replies land a block at a time** — the fork's
  machine digest folding adapts to the new renderer contract.
- **RTL layout** — Arabic and Hebrew ship as full locales; the fork's panels
  are rewritten on logical sides, and the diff body keeps `dir="ltr"` so code
  reads as code under any locale.
- **Team tool naming** — upstream grew its own session tool; the fork's
  `openchamber_team` keeps its own schema (sub-teams, task PR links and
  results), documented in the fork's Team Mode section.
- Dead exports the fork had accumulated are cleaned up; the sidebar pages
  (Missions, Assistants) moved onto upstream's header-driven builtin pages.

## `2.2.0-fork5` — repeated readings, refined specs, Confluence, the board

**A pull remembers its readings.** Starting an analysis again no longer
starts blind: the fresh reading carries a machine digest of the previous
one — its comment and file verdicts, its overall judgement — framed for
what it is, one reading's past opinion, not the truth. The model is told
to re-judge in full: what the pull fixed since, what still stands, and
a whole new reading by the same contract, never a patch on the old one.

- The overview tab lists **every reading** of the pull, newest first,
  each opening its own session; a reading whose answer never fit the
  contract reports as «the previous reading exists», not as a silence.

**A spec admits refinement.** The spec card's open questions now have
their answer: a form under the card takes an answer per question, sends
them to the spec's own session, and the spec is rebuilt whole — the
answered questions fold into the plan, the unanswered ones stay open,
and the session keeps its history of one conversation.

**Jira's description reads the way Jira drawn it.** The issue viewer now
renders the instance's own HTML for the description and comments —
headings, lists, tables, code — purified to the prose tags a viewer may
mount, falling back to the words alone where no DOM can sanitize. The
pulls surface grew state chips over its list — open, merged, declined —
so a glance narrows it, and the issues search grew prefix words:
`assignee:`, `reporter:`, `status:`, `project:` beside the plain text.

**Confluence Data Center joins the panel.** One more integrations card
— origin, token, ssl choice — and the same read-only promise: every
call is a GET, the token never leaving the server, the pages arriving
as the instance rendered them, capped at what the reader holds with an
honest «the rest stayed on the Confluence side».

- The **pages surface** reads and searches: paste a page link or id, or
  search by words; a recently-read rowlist remembers where you were.
  A page reads whole — header facts, rendered body, external link —
  and **Ask about this page** pins its words to the composer as a
  context chip, the text a person would paste, not the tags.
- **A page can ride along as the brief**: the analysis dialog of a pull
  and the spec compose of an issue both grow a page picker — the chosen
  page is fetched fresh at the moment the reading starts and embedded as
  its own section, with the frame the reading needs: treat it as the
  task's context, and where it and the issue text disagree, name the
  conflict in the open questions, never resolve it in silence.

**The review board answers «what needs me next».** One more surface on
the rail: the open pulls of the connected Bitbucket account, each
carrying its last reading's verdict — concerns first, questions next,
approvals after them, reads without a parsed verdict, and the unread
tail — with the Jira field beside them for the sprint's issues, the
same prefix search the issues surface reads.

- A verdict comes from the reading's own answer, parsed by the same
  contract the pull body trusts; a reading still turning says so.
- **A row's click is a handoff**: the pulls or issues surface opens on
  exactly that pull or issue — the same pending-field deal the diff
  handoff uses, consumed once at the opening, never replayed later.

New UI strings carry real translations in all thirteen dictionaries.
Server contracts documented in
`packages/web/server/lib/confluence/DOCUMENTATION.md`.

---

## `2.2.0-fork4` — Bitbucket and Jira, read whole and asked about

**Bitbucket Data Center joins the context panel.** One instance config —
origin, token, ssl choice — on the settings' integrations card; the token
stays on the server, and every call the fork makes is a GET: the viewer
observes, it never writes.

- The panel grows a **pull requests surface**: paste a pull URL or pick
  from the open list, search it by id, title, author or repo; a
  recently-read section remembers where you were.
- A pull reads whole into tabs: **overview**, **comments** with replies,
  **commits**, **changes**.
- **Changes is an interactive diff**: line-number gutters, added and
  removed tint bands, hover, click-select. The ask button on a line
  attaches the file's ±12-line window as a draft quote — a context chip
  in the composer, sent only by your hand.
- **People carry their avatars**: the server proxies
  `/users/<slug>/avatar.png`, so real photos arrive while the token
  never leaves the server; a name-stable initials circle stands in
  whenever the photo cannot (missing slug, failed load, or a runtime
  with images off).
- The team task dialog reuses the reader: **View** on a task's
  Bitbucket pull opens the same body in a dialog.
- New UI strings carry real translations in all thirteen dictionaries.

**Jira Data Center joins the panel the same shape of way.** One more
integrations card — origin, token, ssl choice — and the same read-only
promise: issue view, search and every page behind them is a GET, the
token never leaving the server.

- Paste an issue URL or key, search the project, read one issue whole:
  **overview**, **description**, **comments** with replies, **history**,
  **links**, **attachments**.
- **Ask** pins the issue to the composer as a context chip; issue keys
  typed in chat turn into chips themselves.
- The issue body grows a **spec card**: a session reads the task and
  writes the development spec — essence, a plan bound to the repository,
  acceptance, open questions, out of scope — the card following the
  answer live.

**The pull now answers two pointed questions.** The comments analysis
reads only the open threads and weighs each note against its own line
and file, proposing what would settle it when the note is fair. The
files analysis holds the diff against the task the pull title names —
the key fetched from Jira when it reads, an honest look at the title
alone when it does not. Both report through their own analysing session,
opened from the pull's header.

And the diff's range picker grew a second gesture: press a line and
drag across rows — the span follows the mouse, and the release leaves
it held with its question mark. The two-click flow stays.

Assets for this release: `OpenChamber-beta-2.2.0-fork4-mac-arm64.dmg` (and
the zip) — macOS, Apple silicon.

---

## `2.2.0-fork3` — a finished task carries its result

**The board answers "what did it conclude?" without opening the chat.**
`team.task_update` takes `result`: the owner's final answer, attached in
the same call that marks its own task completed. The teammate briefing and
the tool description say to write the conclusion the user should read,
not a log.

- The result lives on the task, capped at 8000 chars at the parse
  boundary; `teams.json` persists it with the rest of the board.
- Reopening the task drops the stale answer — the board never shows a
  result the task's current status contradicts; a fresh completion
  attaches a fresh one. An empty `result` clears it.
- The details dialog shows a **Result** section on a completed task —
  the text, or an honest line when the owner finished without one; the
  card tooltip carries the answer before the click.
- Tasks completed before this release show the no-result line: their
  answers were never stored.

Assets for this release: `OpenChamber-beta-2.2.0-fork3-mac-arm64.dmg` (and
the zip) — macOS, Apple silicon.

---

## `2.2.0-fork2` — missions queue settings

**The Goals page grows a queue settings card.** How many goals run at
once (1–16, default two) and the watch window in minutes (1–1440, default
one hour). The values live beside the queue in `missions.json` and
survive restarts; a stored value outside the bounds falls back to the
default instead of refusing to boot.

- Raising the limit starts queued goals on the same pass; lowering it
  only stops admissions — running goals are not cancelled.
- A new window arms the watches started after the change; running
  watches keep theirs, so a turn finishing right now is not judged by a
  window it never had.

Assets for this release: `OpenChamber-beta-2.2.0-fork2-mac-arm64.dmg` (and
the zip) — macOS, Apple silicon.

---

## `2.2.0-fork1` — the fork's first release: team operations

The fork turns **Team Mode into a first-class surface** — everything a
team is stays observable from the app — and ships three more product
blocks on top: **Missions**, goal prompts filed into a paced queue of
sessions and teams of their own; **Contacts**, saved assistant personas
each keeping one continuing chat; and three chat flow gifts.

### Team Mode core

**Roster, mailbox, and board from one panel.** A team session's
work-status panel grows a Team section: the roster with every member's
live status and identity colors, the shared task board, and the mailbox
tail — one fetch, refreshed by `openchamber:team-*` event frames.

**Sub-teams and live roster editing.** Four sub-team areas (analytics,
development, review, QA), one lead per domain, domain members report to
their lead instead of the Team Lead. The lead and the user can edit the
roster of a live team: add members, re-brief, remove.

**Task details and portable presets.** Every task opens a details
dialog: brief, owner, blocked-by chain, PR link. Team presets — built-in
recipes plus the user's own saved lineups — so the next team starts one
click away.

**Identity colors.** Stable per-member colors from theme tokens —
readable in light and dark, consistent across roster, board, and
activity.

**Ask the lead to staff.** "Ask the lead to staff a role" turns a plain
wish ("someone to review diffs in fr") into a delegated hiring request —
the lead answers with a named agent and brief, the user confirms or
edits.

**Activity face.** A shared activity feed with the whole team's moves —
messages, task writes, PR changes — paged, with member colors.

**Quick-add a task.** An "Add task" action on the board face: subject,
optional brief, optional owner — the task carries `'user'` when the user
files it themselves.

**A task card answers for its pull request.** Both task tools take a
`prUrl`; the card shows a PR chip with draft/open state, mergeability and
CI verdict from lazily loaded GitHub state (60s cache). Details carry the
clickable link and inline editing.

**A selection can put a task on the board.** In a team chat, the
selection menu grows a **Team task** action: first line becomes the
subject, the rest rides as the brief — via the same quick-add endpoint.

### Missions — goal prompts into a paced queue

A **Goals** page in the sidebar. File a goal prompt, pick a mode — a
fresh **session** that receives it, or a lead-led **team** whose first
task it is — and walk away.

- The executor paces the file: two lanes at a time, the rest queued.
- Each mission's turn is observed and marked completed when it goes
  idle after busy; the watch ends after an hour, so nothing wedges the
  queue.
- Retry, cancel, delete from the list; jump into the working session.
- State survives restarts; every state move is an event frame the page
  refetches on.

### Contacts — saved personas, one continuing chat each

A **Contacts** page beside Goals. Save an assistant as a person: name,
description, the prompt that defines it, optionally a model and an agent.
Each contact keeps one chat and it stays one: open the contact and the
same thread continues; if the thread was deleted, the contact starts a
fresh one seeded with its persona. The persona rides as the first
message, so the model answers as the saved role from the very first
reply.

- Five routes under `/api/openchamber/assistants`; the store lives
  beside the team and mission files.
- Every write broadcasts an `openchamber:assistant-*` frame; open pages
  refetch on it.
- Address-book cards with identity colors, inline create/edit form.

### Chat flow

**`/compactnew`.** Compact the long chat and continue in a fresh one
seeded with the summary — the old chat stays in the list as the archive.

Assets for this release: `OpenChamber-beta-2.2.0-fork1-mac-arm64.dmg` (and
the zip) — macOS, Apple silicon.

---

## Distribution notes

The app is ad-hoc signed and not notarized: on first launch macOS may
refuse it, so right-click → Open once, or run
`xattr -dr com.apple.quarantine "/Applications/Chamberlain.app"`
after dragging it to Applications.

Since `2.4.0-fork1` the flavor carries its own name: **Chamberlain**
(own `productName`, appId `dev.openchamber.chamberlain` and a brass-seal
icon), installed beside stock OpenChamber so both can live on one machine.
Earlier releases shipped the same flavor as "OpenChamber Beta".

## Conventions

All user-facing strings translated in the 13 locales the app ships.
Theme tokens only — no hardcoded palette. Server contracts documented in
`packages/web/server/lib/team/DOCUMENTATION.md`,
`packages/web/server/lib/missions/DOCUMENTATION.md`,
`packages/web/server/lib/assistants/DOCUMENTATION.md` and
`packages/web/server/lib/confluence/DOCUMENTATION.md`.
