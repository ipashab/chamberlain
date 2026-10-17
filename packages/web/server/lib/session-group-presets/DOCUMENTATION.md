# Session Group Presets

Binds a session folder to an agent so the folder works as a *group*: sessions
created inside it start with the group's agent, and a live session dropped
into it is offered a one-time switch to that agent.

The upstream `SessionFolder` entity is not touched. Presets live in their own
table keyed by folder id (`session-group-presets.json` in the OpenChamber
data dir), so the upstream folders module and its merge behaviour stay whole.

## Payload

```
{ version: 1,
  presets: {
    [folderId]: {
      folderId,      // must equal the map key
      defaultAgent,  // agent name from OpenCode's agent list; null clears it
      applyRule,     // 'ask' (default) | 'always' | 'never'
      updatedAt
    }
  },
  removed: [folderId]  // optional; folders this write deletes
}
```

`applyRule` decides what happens when a session that already exists is dropped
into the folder:

- `ask` — the UI offers a single switch to the group's agent; a manual agent
  pick made afterwards wins, and the folder never re-switches on its own.
- `always` — the UI switches without asking.
- `never` — the folder only groups; the session keeps its agent.

A new session created inside the folder always starts on `defaultAgent`,
whatever the rule is.

## Routes

- `GET /api/openchamber/session-group-presets` — the stored snapshot; a
  missing file answers an empty table, malformed state answers 500 instead of
  masquerading as empty.
- `POST /api/openchamber/session-group-presets` — whole-table write (body
  parsed by a route-attached `express.json`, the server parses per route).
  Merges per folder id: the incoming write wins for the folders it names,
  folders it did not mention stay (a hydrating client must not delete what it
  never read). A folder is deleted only by naming it in `removed`, the way
  session folders carry a deletions inbox. A valid write repairs malformed
  prior state. Atomic tmp+rename write, queued so POSTs serialize.

## Validation

- Map key and `preset.folderId` must agree; a disagreeing payload is 400.
- `applyRule` outside the vocabulary is 400; `defaultAgent` over 128 chars is
  400.
