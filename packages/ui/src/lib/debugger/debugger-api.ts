// The debug panel's routes, `/api/openchamber/debugger/*`, as the panel
// calls them. Every answer is parsed here, once, into the types the panel
// renders; a shape the server did not send fails the fetch rather than
// putting half-typed rows on the panel. The contract is the Debugger section
// of `packages/web/server/lib/debugger/DOCUMENTATION.md`.

import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';

const DEBUGGER_STATE_ROUTE = '/api/openchamber/debugger/state';
const DEBUGGER_SESSIONS_ROUTE = '/api/openchamber/debugger/sessions';
const DEBUGGER_VARIABLES_ROUTE = '/api/openchamber/debugger/variables';

const debugVariableSchema = z.object({
  name: z.string(),
  value: z.string(),
  type: z.string().nullish().catch(null),
  // A positive reference means the server can list this variable's children;
  // the tree asks for them only when the row is expanded.
  reference: z.number().int().positive().nullish().catch(null),
});
export type DebugVariable = z.infer<typeof debugVariableSchema>;

const debugScopeSchema = z.object({
  name: z.string(),
  variables: z.array(debugVariableSchema),
});

const debugStackFrameSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  path: z.string().nullable(),
  line: z.number().int().nullable(),
  scopes: z.array(debugScopeSchema),
});
const debugStatusSchema = z.enum(['starting', 'running', 'stopped']);

const debugLaunchSchema = z.object({
  pythonPath: z.string(),
  cwd: z.string(),
  module: z.string().nullable(),
  program: z.string().nullable(),
  args: z.array(z.string()),
  startedAt: z.number(),
});
const debugOutputEntrySchema = z.object({
  category: z.string(),
  output: z.string(),
});

const debugBreakpointsSchema = z.array(z.object({
  path: z.string(),
  lines: z.array(z.number().int().min(1)),
}));

// Pytest results for a run launched as the `pytest` module: one flat node per
// collected test or parametrized case, the panel builds the tree from node ids.
const debugTestStatusSchema = z.enum(['pending', 'running', 'passed', 'failed', 'error', 'skipped']);
export type DebugTestStatus = z.infer<typeof debugTestStatusSchema>;

const debugTestNodeSchema = z.object({
  nodeId: z.string(),
  status: debugTestStatusSchema,
  durationMs: z.number().int().nonnegative().nullable().nullish().catch(null),
  log: z.string().nullish().catch(null),
  error: z.string().nullish().catch(null),
});
export type DebugTestNode = z.infer<typeof debugTestNodeSchema>;

const debugTestsSchema = z.object({
  // The collection total; the node list itself caps below it on huge suites.
  collected: z.number().int().nonnegative().nullable().nullish().catch(null),
  nodes: z.array(debugTestNodeSchema),
});
const debugSessionSchema = z.object({
  status: debugStatusSchema,
  threadId: z.number().int().nullable(),
  currentFrameIndex: z.number().int().nullable(),
  stack: z.array(debugStackFrameSchema),
  error: z.string().nullable().nullish().catch(null),
  launch: debugLaunchSchema,
});
const debugLastExitSchema = z.object({
  exitCode: z.number().int().nullable(),
  finishedAt: z.number(),
  closeReason: z.string(),
  error: z.string().nullable().nullish().catch(null),
  adapterLog: z.string().nullish().catch(null),
  launch: debugLaunchSchema.nullish(),
});
const debuggerStateSchema = z.object({
  session: debugSessionSchema.nullable(),
  breakpoints: debugBreakpointsSchema,
  lastExit: debugLastExitSchema.nullable(),
  outputTail: z.array(debugOutputEntrySchema),
  // Absent from an older server's answer and from non-pytest runs alike.
  tests: debugTestsSchema.nullish().catch(null),
});
export type DebuggerState = z.infer<typeof debuggerStateSchema>;

type DebugLaunchInput = {
  pythonPath: string;
  cwd: string;
  module: string | null;
  program: string | null;
  args: string[];
  breakpoints: Array<{ path: string; lines: number[] }>;
};

export type DebugStepKind = 'over' | 'into' | 'out';

const raiseDebuggerError = async (response: Response, fallback: string): Promise<never> => {
  const body = await response.json().catch(() => null);
  const parsed = z.object({ error: z.string() }).safeParse(body);
  // The server's reason when it sent one; a non-JSON or shapeless refusal
  // falls back to the status code rather than guessing.
  throw new Error(parsed.success && parsed.data.error.trim() ? parsed.data.error : `${fallback}: ${response.status}`);
};

const fetchDebuggerStateUnchecked = async (): Promise<DebuggerState> => {
  const response = await runtimeFetch(DEBUGGER_STATE_ROUTE, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    await raiseDebuggerError(response, 'Debug state request failed');
  }
  const body = await response.json().catch(() => null);
  const parsed = debuggerStateSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error('Debug state response did not match the expected shape');
  }
  return parsed.data;
};

// Panel actions answer with the full state projection, like the routes
// themselves; this keeps one render path for fetch and action updates.
const actionResponse = async (response: Response, fallback: string): Promise<DebuggerState> => {
  if (!response.ok) {
    await raiseDebuggerError(response, fallback);
  }
  const body = await response.json().catch(() => null);
  const parsed = debuggerStateSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error('Debug action response did not match the expected shape');
  }
  return parsed.data;
};

// Every request body the action routes accept, named once so the caller's
// payload stays typed end to end.
type DebugActionBody =
  | DebugLaunchInput
  | { path: string; lines: number[] }
  | { expression: string }
  | { kind: DebugStepKind }
  | { reference: number };

const postDebuggerAction = async (
  route: string,
  body: DebugActionBody | undefined,
  fallback: string,
  method: 'POST' | 'DELETE' = 'POST',
): Promise<DebuggerState> => {
  const headers = new Headers({ accept: 'application/json' });
  if (body !== undefined) {
    headers.set('content-type', 'application/json');
  }
  const response = await runtimeFetch(route, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return actionResponse(response, fallback);
};

export const debuggerApi = {
  state: fetchDebuggerStateUnchecked,
  start: (input: DebugLaunchInput) =>
    postDebuggerAction(DEBUGGER_SESSIONS_ROUTE, input, 'The debug run could not start'),
  stop: () =>
    postDebuggerAction(`${DEBUGGER_SESSIONS_ROUTE}/current`, undefined, 'The debug run could not stop', 'DELETE'),
  setBreakpoints: (path: string, lines: number[]) =>
    postDebuggerAction(`${DEBUGGER_SESSIONS_ROUTE}/current/breakpoints`, { path, lines }, 'The breakpoint could not be set'),
  continue: () =>
    postDebuggerAction(`${DEBUGGER_SESSIONS_ROUTE}/current/continue`, undefined, 'The debuggee could not continue'),
  step: (kind: DebugStepKind) =>
    postDebuggerAction(`${DEBUGGER_SESSIONS_ROUTE}/current/step`, { kind }, 'The step failed'),
  evaluate: (expression: string) => {
    return runtimeFetch(`${DEBUGGER_SESSIONS_ROUTE}/current/evaluate`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ expression }),
    }).then(async (response) => {
      if (!response.ok) {
        await raiseDebuggerError(response, 'The expression could not be evaluated');
      }
      const raw = await response.json().catch(() => null);
      const parsed = z.object({ result: z.string().nullable(), error: z.string().nullish().catch(null) }).safeParse(raw);
      if (!parsed.success) {
        throw new Error('Evaluate response did not match the expected shape');
      }
      return parsed.data;
    });
  },
  // One container's children on demand; references live only while the
  // debuggee stays stopped at the same frame.
  variables: async (reference: number): Promise<DebugVariable[]> => {
    const response = await runtimeFetch(DEBUGGER_VARIABLES_ROUTE, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ reference }),
    });
    if (!response.ok) {
      await raiseDebuggerError(response, 'The variable children could not be loaded');
    }
    const raw = await response.json().catch(() => null);
    const parsed = z.object({ variables: z.array(debugVariableSchema) }).safeParse(raw);
    if (!parsed.success) {
      throw new Error('Variables response did not match the expected shape');
    }
    return parsed.data.variables;
  },
};
