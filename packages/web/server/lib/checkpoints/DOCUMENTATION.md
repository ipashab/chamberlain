# Turn checkpoints

Per-turn checkpoints of what an agent turn changed, in the Cline sense: the
worktree is pinned when a session turns busy, the turn's file-changing tool
calls name the scope, and one action puts those files back — without rewinding
the conversation (that is the timeline's job) and undoable by a second action.

## Where things live

| Piece | File |
|---|---|
| Snapshot and restore primitives over Git | `../git/service.js` (`captureWorktreeSnapshot`, `restoreSnapshotFiles`, `deleteCheckpointRef`) |
| Turn file collection (message pages) | `records.js` |
| Per-session registry, one JSON file per session | `store.js` |
| Hub wiring, restore/undo, ref pinning | `runtime.js` |
| REST surface | `routes.js` |
| Runtime creation and hub subscription | `../../index.js` |
| Route registration | `../opencode/feature-routes-runtime.js` |

## Mechanics

- **Arming.** A `session.status: busy` event captures the whole worktree as
  one tree through a throwaway index (`GIT_INDEX_FILE`): the user's index,
  staged state and `.git/index.lock` stay untouched. The tree is pinned by
  `refs/openchamber/checkpoints/<sessionID>/<armedAt>/base`; a pinned tree
  survives `git gc`, an unpinned one does not.
- **Recording.** When the turn ends (`idle`), the turn's completed `edit`,
  `write` and `patch` calls — read from the session's message pages the way the
  advisor reads its records — name the files. A turn that touched nothing is
  not a checkpoint, and its armed ref is unpinned. The entry replaces an
  older entry for the same user message (a retried or resumed turn), and the
  registry holds at most 15 entries per session; evicted entries hand their
  refs to the runtime's pruner while still pinned.
- **Restore.** `restoreSnapshotFiles` writes the recorded files back from the
  tree into the worktree and touches nothing else: no index rewrite, no
  conversation change. Content is read through `cat-file --filters`, so
  clean/smudge chains like Git LFS round-trip. A file missing from the tree was
  created by the turn and is removed — unless Git currently ignores it, in
  which case it is skipped rather than guessed at. Symlinks are recreated as
  links; gitlinks (submodules) and directory paths are reported as skipped.
- **Undo.** Every restore first captures the state it is about to displace
  (`.../undo`, one ref per checkpoint, overwritten on each toggle), so a second
  action puts it back, and a third toggles again. A failed restore unpins its
  undo ref and does not mark the checkpoint restored.

## Contracts

- `GET /api/openchamber/checkpoints?sessionID=<id>` — the session's registry,
  newest first. A session with no file is a session without checkpoints; a
  malformed registry file is moved aside (`.corrupt-<ts>`), kept for the user,
  and answers as a server error.
- `POST /api/openchamber/checkpoints/restore` with
  `{ sessionID, checkpointID, undo? }` — grades: 400 usage, 404 unknown
  checkpoint, 409 the checkpointed repository cannot be reached, 500 the
  registered state could not be read or written.
- `openchamber:session-checkpoints` broadcast event, `{ sessionID }`, whenever a
  checkpoint is recorded: clients that show the session refetch.
- Setting: `sessionCheckpointsEnabled` (boolean, default on). Saved through the
  settings whitelist in `../opencode/settings-helpers.js`.

## Scope and limits, kept honest

- The snapshot happens at the moment the turn starts. Two sessions editing one
  directory cannot be separated: restoring one returns the worktree as it
  stood, including the other's in-flight changes up to that moment. The
  feature is designed for the common one-session-per-directory case.
- A turn that started while the server was down has no pre-turn snapshot and is
  not checkpointed; the next turn is.
- Ignored files are not snapshotted (`git add -A` respects ignores). An ignored
  file the turn created is skipped on restore instead of deleted, so vendored
  state is never destroyed.
- Restore overwrites later edits to the files the turn touched. The undo ref is
  what makes that survivable; there is exactly one level of undo.
- The list is bounded at 15 checkpoints per session and 500 files per
  checkpoint; a longer file list is stored truncated and marked so.

## Relationship to other snapshot machinery

`snapshotWorktree` in `../git/service.js` serves multirun keep (refs under
`refs/openchamber/runs/`, commits with a parent). Checkpoints use the same
temp-index recipe but different invariants: they support repositories without
any commit, pin trees rather than commits, write under
`refs/openchamber/checkpoints/`, and own the restore half that the runs flow
never had.
