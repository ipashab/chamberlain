# Contact delegation: handing a task to a saved contact

The `openchamber_contacts` managed tool: the delegation half of the contacts
list (the assistants store). One action starts a task — a fork of the calling
conversation that inherits its context — and one action waits for the answer.

## Why it exists

The user addresses a contact by name in chat — "Natasha, audit the checkpoint
store for leaks" — and the agent needs a way to hand the task over without
losing what makes it answerable: the dialog the user and the agent just had,
the files they looked at, the decisions they made. A fresh session starts
empty and has to be taught everything again; the contacts list already holds
the persona, and the calling conversation already holds the context. The
tool joins them: `contact.run` forks the calling conversation so the child
inherits the context, and dispatches the task into the fork with the
contact's own model and agent and its persona heading the task.

## Shape

- `tools.js` — the grammar the agent is taught: three actions
  (`contact.list`, `contact.run`, `contact.wait`) and four parameters
  (`contact`, `task`, `sessionID`, `timeoutMs`). Names, never ids: the user
  says the name in chat, and the agent passes it through. A name resolves by
  exact match first, then by a unique fragment; a fragment two contacts
  answer to is an error that names them both.
- `service.js` — the one executor, with no state of its own beyond the
  in-memory run registry (`sessionID` -> the fork's baselines).

The fork goes through the session service's own `fork` — `runExisting` in
`openchamber-sessions/routes.js` — so a delegated task inherits exactly what
the user's own fork would: the copied history, the fork-inheritance rules,
the dispatch with model and agent overrides. The contact's persona heading
the task is the only composed text: `persona\n\nThe task:\ntext`, or the bare
task when the contact carries no persona.

`contact.wait` resolves inside one call, the way `debug.wait` does: it polls
the child's records until a new `idle` row stands beyond the baselines the
fork handed back (`baselineAssistantMessageId`, `baselineIdleRecordId`), then
reports the newest completed assistant text. The baseline window tells the
truth whatever the turn's size — a turn larger than the window crowds the
baselines out of it, and then every row the window holds is the turn's own.
On timeout the run goes on and the answer names the re-call; a turn that
ended without an answer text is reported by its `idle` outcome, never as a
success with an empty string.

## Lifetimes and limits

Runs live only as long as the server process: a restarted server answers
`contact.wait` for an old child by declining — the baselines that mark the
fork's boundary are gone, and guessing them could read the copied history
as an answer. The wait window is clamped to 1000–900000 ms (default 300000,
poll every 1500 ms); a task is at most 40000 characters.

The tool ships always, like the tracker: without a saved contact the list
answers empty and the run names what it lacks, so there is nothing to gate.
Every call is visible in the chat as a tool call with its full input; the
child session is an ordinary session in the session list, watched live like
any other.
