/**
 * The debug panel's debugpy run, shaped for an agent.
 *
 * The service (../debugger/service.js) owns the DAP mechanics and validates
 * absolute paths only — the panel always sends those. An agent works from the
 * session's directory, so `debug.start` and `debug.breakpoints` also accept
 * relative paths and resolve them here, against `cwd` when given, against the
 * session's directory otherwise. Nothing else about the launch contract is
 * relaxed.
 *
 * `debug.wait` is the piece the panel does not need and the agent cannot live
 * without: polling `debug.state` across turns re-sends the whole context each
 * time, so the wait happens here, inside one call, bounded and cancellable
 * through the same signal every agent action carries.
 */

import path from 'node:path';
import type { createDebuggerService, DebuggerStateProjection } from '../debugger/service.js';
import { asNonEmptyString, isRecord } from '../shared/guards.js';
import { OpenChamberControlError } from './error.js';

const WAIT_ACTION_MIN_TIMEOUT_MS = 1000;
const WAIT_ACTION_MAX_TIMEOUT_MS = 900_000;
const WAIT_ACTION_DEFAULT_TIMEOUT_MS = 300_000;
const WAIT_POLL_INTERVAL_MS = 250;

/** The launch input the debug actions hand to the debugger service. */
export interface DebuggerActionLaunchInput {
  cwd: string;
  module?: string | undefined;
  program?: string | undefined;
  pythonPath?: string | undefined;
  args?: string[] | undefined;
  breakpoints?: { path: string | undefined; lines: unknown }[] | undefined;
}

const resolveFromBases = (candidate: unknown, ...bases: unknown[]): string | undefined => {
  const value = asNonEmptyString(candidate);
  if (value == null) return undefined;
  return path.isAbsolute(value) ? value : path.resolve(...bases.filter((base): base is string => Boolean(base)), value);
};

/**
 * Absolute launch input for the service from the agent's relative world.
 * Throws 400 usage errors before the service can, so the agent gets the
 * action's own vocabulary in the message instead of the panel's.
 */
const buildLaunchInput = (input: Record<string, unknown>, contextDirectory: unknown): DebuggerActionLaunchInput => {
  const explicitCwd = asNonEmptyString(input.cwd);
  const cwd = explicitCwd
    ? (path.isAbsolute(explicitCwd) ? explicitCwd : resolveFromBases(explicitCwd, contextDirectory))
    : asNonEmptyString(contextDirectory);
  if (cwd == null) {
    throw new OpenChamberControlError('debug.start needs a working directory: pass cwd, or run from a session that has one', 400);
  }
  const module = asNonEmptyString(input.module);
  const program = asNonEmptyString(input.program);
  if ((module != null) === (program != null)) {
    throw new OpenChamberControlError('debug.start needs exactly one of module or program', 400);
  }
  const launch: DebuggerActionLaunchInput = { cwd };
  if (module != null) launch.module = module;
  if (program != null) launch.program = resolveFromBases(program, cwd);
  const pythonPath = asNonEmptyString(input.pythonPath);
  if (pythonPath != null) launch.pythonPath = pythonPath;
  if (Array.isArray(input.args)) {
    if (!input.args.every((argument: unknown) => asNonEmptyString(argument) != null)) {
      throw new OpenChamberControlError('The program arguments must be an array of strings', 400);
    }
    launch.args = input.args;
  }
  if (Array.isArray(input.breakpoints)) {
    launch.breakpoints = input.breakpoints.map((entry: unknown) => {
      const fields = isRecord(entry) ? entry : {};
      return {
        path: resolveFromBases(fields.path, cwd),
        lines: fields.lines,
      };
    });
  }
  return launch;
};

interface WaitResult extends DebuggerStateProjection {
  waited: 'stop' | 'exit' | 'timeout';
}

interface WaitOptions {
  state: () => DebuggerStateProjection;
  until: 'stop' | 'exit';
  timeoutMs: number;
  signal: AbortSignal | undefined;
  sleep: (duration: number) => unknown;
}

/**
 * Wait, in one call, until the run stops at a breakpoint or ends.
 *
 * Resolves with the state projection at the moment the condition held, so the
 * answer always says what happened: a stop carries the stack and variables to
 * read, an exit carries `lastExit` and the pytest verdict. A timeout resolves
 * rather than fails — the run keeps going, `debug.wait` simply asks again.
 */
const wait = async ({ state, until, timeoutMs, signal, sleep }: WaitOptions): Promise<WaitResult> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const projection = state();
    const stopped = projection.session?.status === 'stopped';
    const ended = projection.session == null && projection.lastExit != null;
    if (until === 'exit' ? ended : stopped || ended) {
      return { ...projection, waited: until === 'exit' ? 'exit' : stopped ? 'stop' : 'exit' };
    }
    if (projection.session == null) {
      throw new OpenChamberControlError('There is no active run to wait on', 409);
    }
    if (Date.now() >= deadline) {
      return { ...projection, waited: 'timeout' };
    }
    await sleep(WAIT_POLL_INTERVAL_MS);
    if (signal?.aborted) {
      throw new OpenChamberControlError('The wait was cancelled', 409);
    }
  }
};

export interface DebuggerActionsDependencies {
  debuggerService: ReturnType<typeof createDebuggerService>;
  sleep?: ((duration: number) => unknown) | undefined;
}

export interface DebuggerActionOptions {
  signal?: AbortSignal | undefined;
}

export const createDebuggerActions = (dependencies: DebuggerActionsDependencies) => {
  const {
    debuggerService,
    sleep = (duration: number) => new Promise((resolve) => setTimeout(resolve, duration)),
  } = dependencies;

  const execute = async (
    action: string,
    input: unknown = {},
    contextDirectory?: unknown,
    options: DebuggerActionOptions = {},
  ) => {
    const fields = isRecord(input) ? input : {};
    switch (action) {
      case 'debug.start': {
        const launch = buildLaunchInput(fields, contextDirectory);
        return await debuggerService.start(launch);
      }
      case 'debug.wait': {
        const until = fields.until === 'stop' || fields.until === 'exit' ? fields.until : null;
        if (!until) {
          throw new OpenChamberControlError('debug.wait needs until: "stop" or "exit"', 400);
        }
        const timeoutMs = fields.timeoutMs == null
          ? WAIT_ACTION_DEFAULT_TIMEOUT_MS
          : Math.min(Math.max(Math.trunc(Number(fields.timeoutMs) || 0), WAIT_ACTION_MIN_TIMEOUT_MS), WAIT_ACTION_MAX_TIMEOUT_MS);
        return await wait({ state: () => debuggerService.state(), until, timeoutMs, signal: options.signal, sleep });
      }
      case 'debug.state':
        return debuggerService.state();
      case 'debug.stop':
        return await debuggerService.stop();
      case 'debug.breakpoints': {
        const cwd = asNonEmptyString(fields.cwd)
          ? resolveFromBases(fields.cwd, contextDirectory)
          : asNonEmptyString(contextDirectory);
        const entryPath = asNonEmptyString(fields.path);
        if (entryPath == null) {
          throw new OpenChamberControlError('debug.breakpoints needs a file path', 400);
        }
        const entry = { path: resolveFromBases(entryPath, cwd ?? '.') ?? entryPath, lines: fields.lines };
        return await debuggerService.setBreakpoints(entry);
      }
      case 'debug.continue':
        return await debuggerService.continueRun();
      case 'debug.step':
        return await debuggerService.controlStep(fields.kind);
      case 'debug.evaluate':
        return await debuggerService.evaluate({ expression: fields.expression });
      case 'debug.variables':
        return await debuggerService.getVariables({ reference: fields.reference });
      default:
        throw new OpenChamberControlError(`Unsupported debug action: ${action || 'missing'}`, 400);
    }
  };

  return { execute };
};
