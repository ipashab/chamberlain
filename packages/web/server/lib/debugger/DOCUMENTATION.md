# Debugger

Python debugging inside the web surface: the debug panel launches a
`debugpy` DAP adapter, sets breakpoints, steps through pytest runs or
programs, and shows the stopped frame's stack, variables and program
output.

## Shape

```
packages/web/server/lib/debugger/
├── dap-protocol.js              Content-Length framing and request building for the
│                                DAP base protocol. Pure; no sockets.
├── pytest-reporter-plugin.js    The pytest plugin source injected into pytest
│                                runs; emits JSONL test-result events.
├── test-results.js              Accumulates those events into the flat per-test
│                                node list the panel turns into its tree.
├── service.js                   The debug session: spawns the debugpy adapter,
│                                talks DAP, projects state, broadcasts changes.
└── routes.js                    One REST surface, `state()` after every action.
```

The panel is the only intended client; nothing here is part of an agent
tool surface. Running Python on the user's machine is the same trust level
as the terminal's shell runs.

## Routes

Every action answers with the same state projection, so the panel renders
one fetch and re-renders on each `openchamber:debugger-changed` event.

| Method and path | Body | Behavior |
| --- | --- | --- |
| `GET  /api/openchamber/debugger/state` | — | Current state projection |
| `POST /api/openchamber/debugger/sessions` | launch input | Start a debug run |
| `DELETE /api/openchamber/debugger/sessions/current` | — | Stop it |
| `POST /api/openchamber/debugger/sessions/current/breakpoints` | `{ path, lines }` | Set a file's line list live, or store it for the next run |
| `POST /api/openchamber/debugger/sessions/current/continue` | — | Resume the stopped debuggee |
| `POST /api/openchamber/debugger/sessions/current/step` | `{ kind }` | `over` / `into` / `out` |
| `POST /api/openchamber/debugger/sessions/current/evaluate` | `{ expression }` | Evaluate on the top stopped frame |
| `POST /api/openchamber/debugger/variables` | `{ reference }` | Children of one expanded variable |

## Contracts

**Launch input**: `{ pythonPath?, cwd, module | program, args?, breakpoints? }`.
`cwd` and `program` are absolute paths that must exist. A `pythonPath` given
as absolute must exist up front; any other value goes to the spawn, which
resolves a bare command through `PATH`. The literal `python3` means "no
interpreter chosen": before the PATH fallback it is replaced with
`<cwd>/.venv/bin/python` when that file exists, so a venv project launches
with its own interpreter and the "No module named debugpy" of a bare system
python only comes up for projects without a venv. `breakpoints` merges into
the stored list; an empty `lines` clears that file's entry.

**State projection**: `{ session, breakpoints, lastExit, outputTail, tests }`.
`session` is null outside a run. `session.stack` is an array of frames:
`{ id, name, path, line, scopes: [{ name, variables: [{ name, value, type, reference }] }] }`.
A `reference` is non-null exactly when the adapter can list that variable's
children; `POST /variables` with `{ reference }` answers
`{ variables: [...] }` in the same shape. References are only valid while
the debuggee stays stopped at that frame, so the panel drops its expansion
state on every resume. `outputTail` is a bounded ring of
`{ category, output }` entries from DAP `output` events. `lastExit` carries
`exitCode`, `closeReason`, `error` and the adapter's stderr tail so a failed
start explains itself; `adapterLog` names the per-run debugpy log directory
in the system temp.

**Pytest results**: a run launched with `module: "pytest"` additionally gets
the shipped reporter plugin (`-p openchamber_pytest_reporter` with the run's
temp directory prepended to `PYTHONPATH`, events file named by
`OPENCHAMBER_DEBUG_EVENTS`). The service tails that JSONL file while the run
is up and projects `tests`:
`{ collected, nodes: [{ nodeId, status, durationMs, log, error }] }` —
`status` in `pending|running|passed|failed|error|skipped`, `log` the captured
per-test output, `error` the full pytest failure text (for a skip, its reason
line). The list is flat and in collection order; the panel builds the tree
from the node ids (`packages/ui/src/lib/debugger/testTree.ts`). A run that
dies mid-test settles that test as `error` at exit. `tests` is null for
non-pytest runs and for launches whose plugin file could not be written;
it survives the run like `outputTail`, so results stay readable after exit.

**Events**: every state change broadcasts `openchamber:debugger-changed`
with `{ change: 'state' }`; the panel refetches the projection.

**Errors**: domain errors carry an HTTP status (`400` bad input, `409`
nothing to act on, `502` adapter unreachable, `504` adapter timeout) with
a human-readable `error` field.

## Limits (deliberate, prototype)

- One debug session at a time.
- Variables of the two top scopes of each frame, 100 per scope; no watches,
  no variable pagination, no editing live state.
- `justMyCode: false` always, so breakpoints in test plugins hit too.
- The pytest node list caps at 5000 entries (the collected total stays
  true), per-test logs at 64k characters and failure text at 32k.
- Breakpoints live in memory only; a server restart clears them.
- No attach, no remote, no multi-debuggee, no threads view: the session
  follows the thread that last stopped.
