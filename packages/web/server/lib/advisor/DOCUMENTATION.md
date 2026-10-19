# Advisor

Post-turn review of what a turn changed on disk. After a session goes idle,
the advisor re-reads the turn's completed `edit`, `write` and `patch` tool
calls, runs two deterministic passes and an optional Small Model pass, and
stores the findings under session metadata `openchamber.advisor`, shown as a
note under the answer (the recap's placement). The setting
`sessionAdvisorEnabled` (default off) gates the whole runtime.

## Ownership

- `records.js` — the bounded read of one turn's file-changing tool calls;
  the comparable tool-name form; the model-facing digest.
- `rules.js` — the deterministic violation rules over the text a turn added,
  the built-in defaults, and the user's `advisor-rules.json` in the data
  directory.
- `anchors.js` — the read-back: the last change per file re-checked against
  the file on disk after the turn ends.
- `prompt.js` — the Small Model prompts and the tolerant parse of its reply.
- `runtime.js` — the event observer, the guards, the model call, the metadata
  write. `server/index.js` wires it next to `session-assist` on the same event
  hub.
- Provider selection, generation, and overflow behavior:
  `../small-model/DOCUMENTATION.md`. Session metadata and freshness:
  `../session-assist/DOCUMENTATION.md` (the advisor payload follows the
  recap's freshness contract: new activity makes it stale, and the runtime
  deletes what it wrote when a new turn starts).
- UI rendering and the setting live in `packages/ui`
  (`lib/advisorMetadata.ts`, `components/chat/AdvisorNote.tsx`).

## Invariants

- The advisor never messages a session it reviews; it only writes metadata.
  A finding reaches the agent only when the user repeats it.
- Everything the advisor reads about a turn comes from that session's own
  message pages and the files its tool calls named — never a git diff, which
  cannot separate this turn's changes from another session's in the same
  working tree.
- A turn with no completed file-changing tool calls costs one bounded page
  read and writes nothing.
- Only a finding list is stored, never file contents: the payload stays
  small and holds no code the note can leak.
- Invalid `advisor-rules.json` entries are skipped, one bad line never turns
  the defaults off, and the file is re-read every turn so edits apply without
  a restart.
- Subsessions, archived sessions, reverted conversations, and sessions idle
  with a newer user message are left alone.
- The stored payload is deleted when a new turn starts, so a payload in
  metadata always describes the newest turn.

## Decisions

### Why read tool-call records and not a git diff

A diff of the working tree blurs every session editing the same checkout,
and staging state is none of the advisor's business. The tool records carry
exactly this turn's changes, including the old and new text of every edit,
which is also what the anchor pass needs and a diff does not show. Bash-made
changes are the honest cost: the advisor sees file changes the acknowledged
tools made, and says nothing about the rest.

### Why run at idle with no quiet window

The recap waits out a minute so quick follow-ups do not pay a model call per
aborted turn. The advisor's deterministic passes are nearly free, the model
pass is one bounded call, and a finding is most useful while its turn is
still on screen. A new message aborts the run mid-flight and deletes the
stored payload, so no stale review survives a follow-up.

### Why only the last change per file is anchor-checked

Only the final state of a file is observable after the turn; earlier edits
return in later ones. Checking the last `edit` per file pins what actually
matters — that the turn's last word on that file is what the file now says —
without false positives from an edit a later call legitimately replaced.
`patch` calls have no string anchor and stay out of that pass.

### Why the old text is only consulted when the new text is missing

An edit leaves duplicate matches of the old text elsewhere in the file
alone, so "old text still present" alone is not a violation. The two-way
read is exact: old present and new missing is an edit that did not take;
both missing means the spot was rewritten afterwards — a P2 report, not a
claimed failure.

### Why `write` integrity is a P2 and edit misses are P1

A file drifting from the turn's last write can be the user typing in it
seconds later — plausible and harmless. An edit whose new text is gone while
its old text sits there is a real misapplication the agent reported as done.

### Why the model pass is additive and tolerant

Rules and anchors land first and never wait on a model. The Small Model only
adds findings, its reply is parsed as the first JSON array and capped, and
an unparseable or failed reply costs nothing but a log line — a broken model
review never discards the deterministic result and never blocks the write.
