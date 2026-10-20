# Session backlog: staged follow-ups and the drain that runs them

Per-session staged prompts — the queue the user parks in a dialog without
sending — plus the client routes, the `openchamber_backlog` agent tool over
the same authority, and the drain that turns the queue into turns.

## Why it exists

The follow-up queue OpenCode already keeps delivers automatically: a queued
message is sent as soon as the turn ends[^1]. But "not yet" is its own
product: the user wants to sketch what comes next — "park the audit for
later, right now we are talking about the schema" — and start it by their
own word, hours later or not at all. Staging that into the auto-queue would
run it against the user's intent; staging it nowhere loses it. The backlog is
the third place: staged in the dialog's own storage, visible next to the
composer, run only when the user says so — in the interface or in chat.

[^1]: Which is why the backlog lives beside that queue, not inside it: the
        queue's semantic is "next", the backlog's is "when told".

## Shape

- `store.js` — the authority on what is staged: one JSON file per session
  under `<dataDir>/backlog/`, items oldest first, one read-modify-write at a
  time. The list is bounded (50) and refuses the add that would evict — a
  dropped task nobody ever sent is data loss, not pruning. Malformed bytes
  stay failures: the file is moved aside for the user, never silently
  rewritten as an empty queue.
- `tools.js` — the agent-facing grammar: `backlog.list`, `backlog.add`,
  `backlog.remove`, `backlog.clear`, `backlog.run`; the tool works from the
  calling session, so no action takes a session id.
- `service.js` — the single executor over the store. The routes and the
  tool pass through the same `executeAction`, so a staged item means the same
  thing everywhere; the dispatch hands the caller's session id in under its
  own name (`callerSessionID`), the agent's input untouched.
- `routes.js` — the client surface: read, stage, remove, clear, start the
  drain. `openchamber:session-backlog` events tell every client that showed
  the session to refetch, so a stage made in one window is honest in another.

## The drain is watched, not assumed

`backlog.run` starts a background drain and answers at once — usually from a
tool call inside the very turn that must finish first, so the drain begins
by waiting for the session's own turn to end (busy → not busy, polled).

Then the drain takes the head item at a time:

1. Read the newest `idle` record id — the baseline. Read right before the
   send, never taken from the send's own answer, so even a session with no
   `idle` records yet is judged honestly.
2. Hand the item to the session as its own user message — the session's
   current model and agent, an ordinary follow-up.
3. Wait for a new `idle` record standing beyond the baseline, newest first
   until the baseline row: an older `idle` from before the boundary never
   counts as the turn's end. Record ids, never clock times, so a remote
   OpenCode with a skewed clock still matches.
4. Remove the item from the store and take the next.

A prompt the session would not take, or a turn that did not end inside the
window (one hour per item), stops the drain where it stands — the rest of
the queue stays staged and the log says which item held. A drain is one per
session; a second start answers `409` with a name. The queue itself is on
disk, so a restarted server drains again on the user's word.
