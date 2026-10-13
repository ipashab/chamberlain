# OpenChamber fork release notes

**Base:** upstream `openchamber/openchamber` @ `0f57a76` (v2.3.1, 2026-10-13).
The fork pins that base and numbers its own patches with the `forkN` marker.
Each release's notes below carry only that release's changes; `fork1` was the
fork's first release, so its section is the whole set that shipped then.

---

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
`xattr -dr com.apple.quarantine "/Applications/OpenChamber Beta.app"`
after dragging it to Applications.

The beta flavor installs beside stock OpenChamber (own `productName`,
appId and icon), so both can live on one machine.

## Conventions

All user-facing strings translated in the 13 locales the app ships.
Theme tokens only — no hardcoded palette. Server contracts documented in
`packages/web/server/lib/team/DOCUMENTATION.md`,
`packages/web/server/lib/missions/DOCUMENTATION.md`,
`packages/web/server/lib/assistants/DOCUMENTATION.md` and
`packages/web/server/lib/confluence/DOCUMENTATION.md`.
