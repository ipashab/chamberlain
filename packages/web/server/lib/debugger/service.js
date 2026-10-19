/**
 * Python debugging through debugpy's DAP adapter.
 *
 * One active debug session per server: the panel shows the user's current
 * run, and a second concurrent debuggee would have no owner waiting for it.
 * The session spawns `python -m debugpy --listen 127.0.0.1:<port>` in adapter
 * mode, connects to it as a DAP client, and mirrors the parts of the
 * protocol the panel needs: breakpoints, stepping, the stopped frame's stack
 * and variables, and evaluate on the stopped frame. Program stdout/stderr is
 * collected from DAP `output` events into a bounded tail.
 *
 * Multiprocess debuggees are part of one run: pydevd blocks each spawned
 * child until a client session adopts it, so every `debugpyAttach` event is
 * answered with a fresh DAP session whose breakpoints, output and stops feed
 * the same panel; control commands ride the channel the current stop came
 * from.
 *
 * State changes are broadcast as `openchamber:debugger-changed` events; the
 * panel refetches `state()` on each one. No polling anywhere else.
 *
 * Scope is deliberate: no watches, no attaching to a remote process, no
 * per-thread frame trees, no editing of live state. The panel proves the
 * pipeline; what is still missing is listed in DOCUMENTATION.md.
 *
 * pytest launches additionally run the shipped reporter plugin (`-p` through
 * the run's temp directory) and tail its JSONL events file into a per-test
 * result projection, so the panel can show the run as a test tree.
 */

import net from 'node:net';
import { spawn } from 'node:child_process';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildDapRequest, decodeDapChunk, encodeDapMessage } from './dap-protocol.js';
import { PYTEST_REPORTER_PLUGIN } from './pytest-reporter-plugin.js';
import {
  consumeTestEventsLine,
  createTestTracker,
  finalizeTestTracker,
  testsProjection,
} from './test-results.js';
import { isPlainObject, isString } from '../shared/guards.js';

const CONNECT_ATTEMPT_TIMEOUT_MS = 2_000;
const CONNECT_TOTAL_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 10_000;
const DISCONNECT_GRACE_MS = 2_000;
const CHILD_EXIT_GRACE_MS = 3_000;
const STACK_FRAME_LIMIT = 50;
// Variables for the top two scopes cover "Locals" plus one more; deeper
// scopes are the debuggee's internals and never earned their round trip.
const SCOPE_VARIABLE_LIMIT = 2;
const VARIABLES_PER_SCOPE_LIMIT = 100;
const STRING_MAX_CHARS = 512;
const ADAPTER_STDERR_TAIL_CHARS = 8_000;
const OUTPUT_TAIL_TOTAL_CHARS = 120_000;
const OUTPUT_ENTRY_MAX_CHARS = 2_000;
const STEP_KINDS = Object.freeze(new Set(['over', 'into', 'out']));
// The reporter's events file is polled, not watched: pytest appends in bulk
// and a short interval keeps the tree lively without an fs watcher per run.
const TEST_EVENTS_POLL_MS = 500;
const PYTEST_PLUGIN_NAME = 'openchamber_pytest_reporter';

const isStringArray = (value) => Array.isArray(value) && value.every(isString);

class DebuggerError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

const clipString = (value, maxChars) => {
  const text = isString(value) ? value : String(value);
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
};

/** Picks a free loopback TCP port by asking the OS for one and releasing it. */
const pickLoopbackPort = async (netModule) =>
  new Promise((resolve, reject) => {
    const probe = netModule.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

const normalizeBreakpointPair = (entry) => {
  if (!isPlainObject(entry) || !isString(entry.path)) {
    throw new DebuggerError('Each breakpoint entry needs a file path', 400);
  }
  if (!path.isAbsolute(entry.path)) {
    throw new DebuggerError(`Breakpoint path must be absolute: ${entry.path}`, 400);
  }
  const lines = entry.lines;
  if (!Array.isArray(lines) || !lines.every((line) => Number.isInteger(line) && line >= 1)) {
    throw new DebuggerError(`Breakpoint lines must be an array of 1-based line numbers: ${entry.path}`, 400);
  }
  // An empty list clears the file's breakpoints; duplicates make no sense.
  return { path: entry.path, lines: [...new Set(lines)].sort((a, b) => a - b) };
};

export const createDebuggerService = (dependencies = {}) => {
  const {
    broadcastUiEvent = null,
    net: netModule = net,
    spawn: spawnModule = spawn,
    fsPromises: fsModule = fsPromises,
  } = dependencies;

  let session = null;
  let lastExit = null;
  // Breakpoints survive runs: the panel keeps its list when the debuggee ends.
  const breakpointsByPath = new Map();

  const broadcast = () => {
    if (broadcastUiEvent) {
      broadcastUiEvent({ type: 'openchamber:debugger-changed', properties: { change: 'state' } });
    }
  };

  const pushOutput = (target, category, text) => {
    let output = clipString(text, OUTPUT_ENTRY_MAX_CHARS);
    while (
      target.outputTailTotal + output.length > OUTPUT_TAIL_TOTAL_CHARS &&
      target.outputTail.length > 0
    ) {
      const popped = target.outputTail.shift();
      target.outputTailTotal -= popped.output.length;
    }
    target.outputTail.push({ category, output });
    target.outputTailTotal += output.length;
  };

  const noteAdapterDiagnostics = (target, line) => {
    target.adapterDiagnostics.push(clipString(line, ADAPTER_STDERR_TAIL_CHARS));
    if (target.adapterDiagnostics.length > 8) target.adapterDiagnostics.shift();
  };

  /**
   * Applies the complete pytest event lines the reporter appended since the
   * last pull. Half-written lines stay behind the offset for the next pull;
   * any file-level failure only loses report detail, never the run itself.
   */
  const drainTestEvents = async (target) => {
    if (target.testsEventsFile == null || target.testsTracker == null) return false;
    let size;
    try {
      size = (await fsModule.stat(target.testsEventsFile)).size;
    } catch {
      return false; // The reporter has not created the file yet.
    }
    if (size <= target.testsOffset) return false;
    try {
      const handle = await fsModule.open(target.testsEventsFile, 'r');
      try {
        const buffer = Buffer.alloc(size - target.testsOffset);
        await handle.read(buffer, 0, buffer.length, target.testsOffset);
        const text = buffer.toString('utf8');
        const lastNewline = text.lastIndexOf('\n');
        if (lastNewline === -1) return false;
        const complete = text.slice(0, lastNewline);
        target.testsOffset += Buffer.byteLength(complete, 'utf8') + 1;
        let changed = false;
        for (const line of complete.split('\n')) {
          if (line.length > 0 && consumeTestEventsLine(target.testsTracker, line)) changed = true;
        }
        return changed;
      } finally {
        await handle.close();
      }
    } catch {
      return false;
    }
  };

  /**
   * Settles the pytest report (last event pull, running tests marked) and
   * then closes the books on the run. The pull is awaited, so the identity
   * check after it is what keeps a replaced run from overwriting its
   * successor's exit record.
   */
  const finishAfterTestEvents = async (owned, exitCode, closeReason, error, options) => {
    if (owned.testsTracker != null) {
      await drainTestEvents(owned);
      finalizeTestTracker(owned.testsTracker);
    }
    if (session != null && session !== owned) return;
    finishWithExit(exitCode, closeReason, error, options);
  };

  const teardownSession = (closeReason, options = {}) => {
    if (!session) return;
    const closed = session;
    session = null;
    // Adopted subprocess channels go down with the run; their pending
    // requests share its fate without touching the bookkeeping of whatever
    // run starts next.
    closed.subprocesses.forEach((entry) => {
      if (closed.subprocesses.get(entry.pid) === entry) closeSubprocessChannel(closed, entry);
    });
    closed.pending.forEach((pending) => {
      clearTimeout(pending.timer);
      pending.reject(new DebuggerError(`The debug session ended before the reply: ${closeReason}`, 502));
    });
    closed.pending.clear();
    closed.attachBarrier?.reject(new DebuggerError(closeReason, 502));
    if (closed.testsTimer != null) clearInterval(closed.testsTimer);
    if (closed.child.exitCode == null && !closed.child.killed) {
      if (options.killChild === false) {
        // A naturally ended debuggee is allowed to report its own exit code;
        // the child exit handler or this safety timer closes the book.
        const safetyKill = setTimeout(() => {
          if (closed.child.exitCode == null && !closed.child.killed) closed.child.kill('SIGKILL');
        }, CHILD_EXIT_GRACE_MS);
        safetyKill.unref?.();
      } else {
        closed.child.kill('SIGKILL');
      }
    }
    closed.socket?.destroy();
  };

  const finishWithExit = (exitCode, closeReason, error, options) => {
    if (!session) return;
    // A DAP `terminated` can beat the child's exit event and carries no code;
    // an exit code the child already recorded is the verdict worth keeping.
    const settledExitCode = exitCode ?? session.child?.exitCode ?? null;
    lastExit = {
      exitCode: settledExitCode,
      finishedAt: Date.now(),
      closeReason,
      error: error ?? null,
      adapterDiagnostics: [...session.adapterDiagnostics],
      // The per-run debugpy log directory in the system temp: the deepest
      // diagnostics of an early adapter death live there.
      adapterLog: session.adapterLog,
      outputTail: session.outputTail,
      tests: session.testsTracker == null ? null : testsProjection(session.testsTracker),
      launch: session.launchEcho,
      breakpoints: [...breakpointsByPath.entries()].map(([breakpointPath, lines]) => ({ path: breakpointPath, lines })),
    };
    teardownSession(closeReason, options);
    broadcast();
  };

  // A channel is { socket, seq, pending }: the root session is one, and each
  // adopted subprocess gets its own. Requests for a channel must never
  // resolve against another channel's pending map, so the send is explicit
  // about its target and the shared `sendRequest` picks the control route.
  const sendOnChannel = (channel, command, args, timeoutMs = REQUEST_TIMEOUT_MS) => {
  const promise = new Promise((resolve, reject) => {
    if (channel == null || channel.socket == null) {
      reject(new DebuggerError('There is no channel for that debug request', 409));
      return;
    }
    channel.seq += 1;
    const requestSeq = channel.seq;
    const timer = setTimeout(() => {
      channel.pending.delete(requestSeq);
      reject(new DebuggerError(`The debug adapter did not answer ${command} in time`, 504));
    }, timeoutMs);
    channel.pending.set(requestSeq, { resolve, reject, timer, command });
    channel.socket.write(encodeDapMessage(buildDapRequest(requestSeq, command, args)));
  });
  // A teardown-time rejection storm must never take the whole server
  // down because one caller's await raced the teardown. The noop
  // observer only marks the rejection as seen; real consumers still
  // get it through their own awaits.
  promise.catch(() => {});
  return promise;
};

  const sendRequest = (command, args, timeoutMs = REQUEST_TIMEOUT_MS) => {
    if (!session) {
      return Promise.reject(new DebuggerError('There is no active debug session', 409));
    }
    return sendOnChannel(session.control ?? session, command, args, timeoutMs);
  };

  const resolveRequest = (target, message) => {
    const requestSeq = message.request_seq;
    const pending = target.pending.get(requestSeq);
    if (!pending) return;
    target.pending.delete(requestSeq);
    clearTimeout(pending.timer);
    if (message.success === true) {
      pending.resolve(message.body ?? {});
    } else {
      pending.reject(new DebuggerError(`Debug adapter error in ${message.command}: ${String(message.message)}`, 500));
    }
  };

  const sanitizeVariables = (rawVariables) => {
    const entries = Array.isArray(rawVariables) ? rawVariables : [];
    return entries.slice(0, VARIABLES_PER_SCOPE_LIMIT).map((variable) => ({
      name: clipString(variable?.name, STRING_MAX_CHARS),
      value: clipString(variable?.value, STRING_MAX_CHARS),
      type: isString(variable?.type) ? clipString(variable.type, STRING_MAX_CHARS) : null,
      // A positive reference means the adapter can list this variable's
      // children on demand; null means the value shown is the whole value.
      reference: Number.isInteger(variable?.variablesReference) && variable.variablesReference > 0
        ? variable.variablesReference
        : null,
    }));
  };

  const sanitizeFrame = (frame, index, scopes) => ({
    id: index,
    dapId: Number.isInteger(frame?.id) ? frame.id : null,
    name: isString(frame?.name) ? frame.name : 'unknown',
    path: isString(frame?.source?.path) ? frame.source.path : null,
    line: Number.isInteger(frame?.line) ? frame.line : null,
    scopes,
  });

  const frameScopes = async (dapFrameId) => {
    const scopesResponse = await sendRequest('scopes', { frameId: dapFrameId });
    const scopes = Array.isArray(scopesResponse?.scopes) ? scopesResponse.scopes : [];
    const collected = [];
    for (const scope of scopes.slice(0, SCOPE_VARIABLE_LIMIT)) {
      const variablesResponse = await sendRequest('variables', {
        variablesReference: scope.variablesReference,
      });
      collected.push({
        name: isString(scope?.name) ? scope.name : 'scope',
        variables: sanitizeVariables(variablesResponse?.variables),
      });
    }
    return collected;
  };

  const readStoppedState = async (target, threadId) => {
    if (!Number.isInteger(threadId)) {
      return;
    }
    const stackResponse = await sendRequest('stackTrace', { threadId, levels: STACK_FRAME_LIMIT });
    const frames = Array.isArray(stackResponse?.stackFrames) ? stackResponse.stackFrames : [];
    target.threadId = threadId;
    target.status = 'stopped';
    target.stack = [];
    for (let index = 0; index < Math.min(frames.length, STACK_FRAME_LIMIT); index += 1) {
      const scopes = await frameScopes(frames[index].id);
      target.stack.push(sanitizeFrame(frames[index], index, scopes));
    }
    target.currentFrameIndex = target.stack.length > 0 ? 0 : null;
    broadcast();
  };

  // Breakpoints belong to every live channel: the root session and each
  // adopted subprocess hold their own copy with pydevd, so a change goes
  // out to all of them, best effort per channel.
  const liveChannels = (target) => [target, ...target.subprocesses.values()];

  const sendBreakpointsToChannel = async (channel, breakpointPath) => {
    const entries = breakpointPath == null
      ? [...breakpointsByPath.entries()]
      : [[breakpointPath, breakpointsByPath.get(breakpointPath) ?? []]];
    for (const [breakpointPath_, lines] of entries) {
      await sendOnChannel(channel, 'setBreakpoints', {
        source: { path: breakpointPath_ },
        // DAP deprecated the `lines` field; adapters register only
        // `breakpoints` entries.
        breakpoints: lines.map((line) => ({ line })),
        sourceModified: false,
      });
    }
  };

  const sendCurrentBreakpoints = async (target, breakpointPath) => {
    await Promise.allSettled(liveChannels(target).map((channel) => sendBreakpointsToChannel(channel, breakpointPath)));
  };

  // Closes one adopted subprocess channel; the run itself stays alive — a
  // child exiting is the debuggee's own lifecycle, not the run's verdict.
  const closeSubprocessChannel = (target, entry) => {
    if (entry.closed) return;
    if (target.subprocesses.get(entry.pid) !== entry) return;
    console.warn(`[dbg-close] pid=${entry.pid} pending=${JSON.stringify([...entry.pending.values()].map((p) => p.command))} control=${target.control === entry}`);
    entry.closed = true;
    target.subprocesses.delete(entry.pid);
    if (target.control === entry) target.control = null;
    entry.pending.forEach((pending) => {
      clearTimeout(pending.timer);
      pending.reject(new DebuggerError('The subprocess debug session ended', 502));
    });
    entry.pending.clear();
    entry.attachBarrier?.reject(new DebuggerError('The subprocess debug session ended', 502));
    entry.socket?.destroy();
  };

  // pydevd blocks a multiprocess child until a client session adopts it, and
  // the adapter offers each child through a `debugpyAttach` event. Answering
  // with a fresh DAP session over the adapter's client socket unblocks the
  // child and puts its breakpoints, output and stops under this same run.
  const adoptSubprocess = async (target, body) => {
    const pid = body?.subProcessId;
    const host = body?.connect?.host;
    const port = body?.connect?.port;
    if (!Number.isInteger(pid) || !Number.isInteger(port) || !isString(host)) return;
    if (host !== '127.0.0.1' && host !== 'localhost') return;
    if (target.subprocesses.has(pid)) return;
    const barrier = { promise: null, resolve: null, reject: null };
    barrier.promise = new Promise((resolve, reject) => {
      barrier.resolve = resolve;
      barrier.reject = reject;
    });
    // The barrier can reject (session teardown) before this adoption wires
    // its own handlers; a noop observer keeps that rejection from becoming
    // an unhandled one while Promise.all below still sees the failure.
    barrier.promise.catch(() => {});
    const entry = {
      pid,
      closed: false,
      socket: null,
      seq: 0,
      pending: new Map(),
      parserState: { buffer: '' },
      attachBarrier: barrier,
    };
    target.subprocesses.set(pid, entry);
    try {
      const socket = await connectToAdapter(port);
      if (session !== target || entry.closed) {
        socket.destroy();
        return;
      }
      entry.socket = socket;
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        if (session !== target) return;
        let messages;
        try {
          messages = decodeDapChunk(entry.parserState, chunk);
        } catch {
          socket?.destroy();
          return;
        }
        for (const message of messages) {
          if (session !== target) return;
          if (message.type === 'response') {
            resolveRequest(entry, message);
          } else if (message.type === 'event') {
            void handleEvent(target, message, entry).catch(() => {});
          }
        }
      });
      socket.on('close', () => {
        if (session === target) closeSubprocessChannel(target, entry);
      });
      const initializeReply = sendOnChannel(entry, 'initialize', {
        adapterID: 'debugpy',
        clientID: 'openchamber',
        clientName: 'OpenChamber',
        linesStartAt1: true,
        columnsStartAt1: true,
        supportsVariableType: true,
      }, 2 * REQUEST_TIMEOUT_MS);
      const attachReply = sendOnChannel(entry, 'attach', {
        type: 'debugpy',
        request: 'attach',
        name: `subprocess ${pid}`,
        redirectOutput: true,
        justMyCode: false,
        subProcessId: pid,
      }, 6 * REQUEST_TIMEOUT_MS);
      await Promise.all([initializeReply, attachReply, barrier.promise]);
    } catch {
      closeSubprocessChannel(target, entry);
    }
  };

  const handleEvent = async (target, message, channel) => {
    const event = message.event;
    if (event === 'initialized') {
      await sendBreakpointsToChannel(channel, null);
      await sendOnChannel(channel, 'setExceptionBreakpoints', { filters: [] });
      await sendOnChannel(channel, 'configurationDone');
      channel.attachBarrier?.resolve();
      return;
    }
    if (event === 'output') {
      const { body = {} } = message;
      pushOutput(target, isString(body.category) ? body.category : 'console', isString(body.output) ? body.output : '');
      broadcast();
      return;
    }
    if (event === 'stopped') {
      // The panel's control commands answer the channel the stop came from.
      target.control = channel;
      await readStoppedState(target, message.body?.threadId);
      return;
    }
    if (event === 'continued') {
      if (target.control !== channel) return;
      target.status = 'running';
      target.stack = [];
      target.currentFrameIndex = null;
      broadcast();
      return;
    }
    if (event === 'exited') {
      if (channel !== target) {
        // A child's exit is its own; only the root channel's exit closes
        // the run.
        closeSubprocessChannel(target, channel);
        return;
      }
      const code = message.body?.exitCode;
      await finishAfterTestEvents(target, Number.isInteger(code) ? code : null, `the debuggee exited${code != null ? ` with code ${code}` : ''}`, null, { killChild: false });
      return;
    }
    if (event === 'terminated') {
      if (channel !== target) {
        closeSubprocessChannel(target, channel);
        return;
      }
      // The child's own exit handler records the code pydevd never sends
      // in CLI mode.
      await finishAfterTestEvents(target, null, 'the debug adapter terminated the session', null, { killChild: false });
      return;
    }
    if (event === 'debugpyAttach') {
      await adoptSubprocess(target, message.body);
      return;
    }
  };

  const connectToAdapter = (port) =>
    new Promise((resolve, reject) => {
      const deadline = Date.now() + CONNECT_TOTAL_TIMEOUT_MS;
      // An adapter that dies before answering is a broken debugpy install
      // more often than a race; its own stderr names the real cause.
      const adapterFailure = () => {
        const diagnostics = ((session?.adapterDiagnostics ?? lastExit?.adapterDiagnostics ?? []).join('\n').trim());
        if (!session) {
          reject(new DebuggerError(
            diagnostics.length > 0
              ? `The debug adapter exited before answering: ${clipString(diagnostics, 400)}`
              : `The debug session was stopped before the adapter answered`,
            502,
          ));
          return;
        }
        reject(new DebuggerError(`Could not reach the debug adapter: is debugpy installed for ${session.launchEcho.pythonPath}?`, 502));
      };
      const attempt = () => {
        if (session == null) {
          adapterFailure();
          return;
        }
        const socket = netModule.connect({ host: '127.0.0.1', port });
        socket.setNoDelay(true);
        socket.setTimeout(CONNECT_ATTEMPT_TIMEOUT_MS);
        let settled = false;
        const giveUp = (reason) => {
          if (settled) return;
          settled = true;
          socket.destroy();
          if (Date.now() > deadline || session == null) {
            adapterFailure();
          } else {
            setTimeout(attempt, 150);
          }
        };
        socket.once('timeout', () => giveUp('the connect attempt timed out'));
        socket.once('error', (error) => giveUp(error.message));
        socket.once('connect', () => {
          if (settled) return;
          settled = true;
          socket.setTimeout(0);
          resolve(socket);
        });
      };
      attempt();
    });

  const normalizeLaunchInput = async (input) => {
    if (!isPlainObject(input)) {
      throw new DebuggerError('Launch input must be an object', 400);
    }
    const cwd = input.cwd;
    if (!isString(cwd) || !path.isAbsolute(cwd)) {
      throw new DebuggerError('The working directory must be an absolute path', 400);
    }
    const module = isString(input.module) ? input.module : null;
    const program = isString(input.program) ? input.program : null;
    if ((module != null) === (program != null)) {
      throw new DebuggerError('Pass either a module or a program, not both', 400);
    }
    if (program != null && !path.isAbsolute(program)) {
      throw new DebuggerError('The program path must be absolute', 400);
    }
    const args = input.args == null ? [] : input.args;
    if (!isStringArray(args)) {
      throw new DebuggerError('Program arguments must be an array of strings', 400);
    }
    // The untouched `python3` default means "no interpreter chosen"; a venv
    // in the working directory is the interpreter the project meant, and it
    // wins before PATH resolves some system python without debugpy.
    let pythonPath = isString(input.pythonPath) ? input.pythonPath : 'python3';
    if (pythonPath === 'python3') {
      const venvPython = path.join(cwd, '.venv', 'bin', 'python');
      try {
        await fsModule.stat(venvPython);
        pythonPath = venvPython;
      } catch {
        // No venv there — the bare command resolves through PATH by spawn.
      }
    }
    const breakpoints = input.breakpoints == null ? [] : input.breakpoints;
    if (!Array.isArray(breakpoints)) {
      throw new DebuggerError('Breakpoints must be an array of { path, lines } entries', 400);
    }
    const entries = breakpoints.map(normalizeBreakpointPair).filter(({ lines }) => lines.length > 0);
    let cwdStat;
    try {
      cwdStat = await fsModule.stat(cwd);
    } catch {
      throw new DebuggerError(`Working directory does not exist: ${cwd}`, 400);
    }
    if (!cwdStat.isDirectory()) {
      throw new DebuggerError(`The working directory is not a directory: ${cwd}`, 400);
    }
    // A bare command like `python3` is resolved through PATH by spawn; only
    // an interpreter path given as absolute has to exist up front.
    if (path.isAbsolute(pythonPath)) {
      try {
        await fsModule.stat(pythonPath);
      } catch {
        throw new DebuggerError(`Python interpreter does not exist: ${pythonPath}`, 400);
      }
    }
    return { pythonPath, cwd, module, program, args, breakpoints: entries };
  };

  const start = async (input) => {
    if (session) {
      throw new DebuggerError('A debug run is already active; stop it first', 409);
    }
    const launch = await normalizeLaunchInput(input);
    const port = await pickLoopbackPort(netModule);
    // debugpy's own diagnostics are the one thing that explains an early
    // session termination; they go to a per-run temp directory so the
    // debuggee's checkout stays clean.
    let logDir;
    try {
      logDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'openchamber-debugpy-'));
    } catch {
      throw new DebuggerError('Could not create the debugpy log directory', 500);
    }

    // pytest runs get the shipped reporter: per-test events let the panel
    // draw the result tree while the run is up. A plugin file that cannot be
    // written degrades to a run without the tree — the report is an add-on,
    // the run is the core.
    const pytestEventsFile = path.join(logDir, 'pytest-events.jsonl');
    let testsTracker = null;
    if (launch.module === 'pytest') {
      try {
        await fsModule.writeFile(
          path.join(logDir, `${PYTEST_PLUGIN_NAME}.py`),
          PYTEST_REPORTER_PLUGIN,
          'utf8',
        );
        testsTracker = createTestTracker();
      } catch {
        testsTracker = null;
      }
    }

    // debugpy's CLI has no adapter-only mode: the target rides the command
    // line and `--wait-for-client` holds it back until we connect, so the DAP
    // session is an attach to our own child.
    const child = spawnModule(
      launch.pythonPath,
      [
        '-Xfrozen_modules=off',
        '-m', 'debugpy',
        '--listen', `127.0.0.1:${port}`,
        '--wait-for-client',
        '--log-to', logDir,
        ...(launch.module == null ? [launch.program] : ['-m', launch.module]),
        ...(testsTracker == null ? [] : ['-p', PYTEST_PLUGIN_NAME]),
        ...launch.args,
      ],
      {
        cwd: launch.cwd,
        env: testsTracker == null
          ? process.env
          : {
              ...process.env,
              OPENCHAMBER_DEBUG_EVENTS: pytestEventsFile,
              // The plugin import has to resolve from the run's temp dir;
              // the project's own PYTHONPATH, when any, stays behind it.
              PYTHONPATH: process.env.PYTHONPATH
                ? `${logDir}${path.delimiter}${process.env.PYTHONPATH}`
                : logDir,
            },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    child.stderr.setEncoding('utf8');
    session = {
      status: 'starting',
      threadId: null,
      stack: [],
      currentFrameIndex: null,
      breakpoints: new Map(),
      outputTail: [],
      outputTailTotal: 0,
      adapterDiagnostics: [],
      seq: 0,
      pending: new Map(),
      socket: null,
      // Subprocess DAP sessions adopted on `debugpyAttach`: pid → channel.
      // pydevd blocks a multiprocess child until a client session answers
      // for it, so the run keeps one channel per adopted child beside the
      // root channel above.
      subprocesses: new Map(),
      // The channel the panel's control commands ride: the root session,
      // or the subprocess whose `stopped` the panel is showing.
      control: null,
      child,
      attachBarrier: null,
      error: null,
      adapterLog: logDir,
      testsTracker,
      testsEventsFile: testsTracker == null ? null : pytestEventsFile,
      testsOffset: 0,
      testsTimer: null,
      launchEcho: {
        pythonPath: launch.pythonPath,
        cwd: launch.cwd,
        module: launch.module,
        program: launch.program,
        args: launch.args,
        startedAt: Date.now(),
      },
    };
    // Every handler below belongs to THIS session object. The process and the
    // socket outlive the session they opened (the child exits after
    // `terminated`, the socket drains after teardown), and a handler that
    // checked only "is any session active" could act on a run that started
    // after its own ended — killing it with the old child's exit code. The
    // identity check keeps late events harmless.
    const owned = session;
    // A new run clears the reported failure of the previous one.
    lastExit = null;
    if (owned.testsTracker != null) {
      const timer = setInterval(() => {
        if (session !== owned) return;
        void drainTestEvents(owned)
          .then((changed) => {
            if (changed) broadcast();
          })
          .catch(() => {});
      }, TEST_EVENTS_POLL_MS);
      timer.unref?.();
      owned.testsTimer = timer;
    }
    for (const { path: breakpointPath, lines } of launch.breakpoints) {
      breakpointsByPath.set(breakpointPath, lines);
    }
    child.stderr.on('data', (chunk) => {
      if (session === owned) noteAdapterDiagnostics(owned, chunk);
    });
    child.on('error', (error) => {
      if (session !== owned) return;
      void finishAfterTestEvents(owned, null, `the debug adapter process failed to start: ${error.message}`, error.message);
    });
    child.on('exit', (code) => {
      if (session !== owned) return;
      if (session.status === 'starting') {
        const diagnostics = session.adapterDiagnostics.join('\n').trim();
        void finishAfterTestEvents(
          owned,
          code,
          `the debug adapter exited while starting with code ${code}`,
          diagnostics.length > 0 ? diagnostics : null,
        );
        return;
      }
      void finishAfterTestEvents(owned, code, `the debug adapter exited with code ${code}`);
    });
    // debugpy's terminate flow reports `terminated` without an `exited`
    // event in CLI mode, so the child's own exit code is the last chance to
    // keep pytest's pass/fail verdict in the projection.
    const recordProcessExitCode = (code) => {
      // After this session ended the global is null and patching lastExit is
      // the point; a global pointing at a DIFFERENT run means this event
      // belongs to history and must not be written anywhere.
      if (session != null && session !== owned) return;
      if (lastExit && lastExit.exitCode == null) {
        lastExit.exitCode = code;
        broadcast();
      }
    };
    child.on('exit', recordProcessExitCode);

    try {
      const socket = await connectToAdapter(port);
      if (!session) throw new DebuggerError('The debug session was stopped before the adapter answered', 409);
      session.socket = socket;
      socket.setEncoding('utf8');
      const parserState = { buffer: '' };
      socket.on('data', (chunk) => {
        let messages;
        try {
          messages = decodeDapChunk(parserState, chunk);
        } catch (error) {
          if (session === owned) {
            finishWithExit(null, `the DAP stream became unreadable: ${error.message}`, error.message);
          }
          return;
        }
        for (const message of messages) {
          if (session !== owned) return;
          if (message.type === 'response') {
            resolveRequest(owned, message);
          } else if (message.type === 'event') {
            // No serialized queue: a handler that awaits a request reply must
            // not block delivery of that reply. Ordering stays correct where
            // it matters, because the debuggee only runs after the
            // `initialized` handler finishes configurationDone.
            void handleEvent(owned, message, owned).catch((error) => {
              // A failed frame read leaves the session alive; the panel
              // shows the error and the user can still step or stop. A
              // handler that raced the session's end is simply dropped.
              if (session !== owned) return;
              owned.error = clipString(String(error?.message ?? error), ADAPTER_STDERR_TAIL_CHARS);
              broadcast();
            });
          }
        }
      });
      socket.on('close', () => {
        // A finished session's socket closes when the child exits; only a
        // live session needs to report the loss.
        if (session === owned) {
          void finishAfterTestEvents(owned, null, 'the adapter connection closed');
        }
      });
      await sendRequest('initialize', {
        adapterID: 'debugpy',
        clientID: 'openchamber',
        clientName: 'OpenChamber',
        linesStartAt1: true,
        columnsStartAt1: true,
        supportsVariableType: true,
      }, 2 * REQUEST_TIMEOUT_MS);
      session.status = 'running';
      // The attach reply lands after configurationDone; the barrier in the
      // `initialized` handler is what actually gates readiness.
      const attachReply = sendRequest('attach', {
        type: 'debugpy',
        request: 'attach',
        name: 'openchamber-debug',
        redirectOutput: true,
        justMyCode: false,
      }, 6 * REQUEST_TIMEOUT_MS);
      const barrier = { promise: null, resolve: null, reject: null };
      barrier.promise = new Promise((resolve, reject) => {
        barrier.resolve = resolve;
        barrier.reject = reject;
      });
      owned.attachBarrier = barrier;
      await Promise.all([barrier.promise, attachReply]);
      if (session !== owned) {
        // The run was stopped and another one started while this start was
        // resolving; its state is not this answer's to report.
        throw new DebuggerError('The debug session ended during startup', 409);
      }
    } catch (error) {
      // A run that was replaced while this one resolved owns neither the
      // projection nor the teardown of its successor.
      if (session === owned) {
        const reason = error instanceof DebuggerError ? error.message : String(error?.message ?? error);
        finishWithExit(null, reason, reason);
      }
      throw error;
    }
    broadcast();
    return state();
  };

  const requireSession = () => {
    if (!session) {
      throw new DebuggerError('There is no active debug session', 409);
    }
    return session;
  };

  const requireStoppedSession = () => {
    const active = requireSession();
    if (active.status !== 'stopped') {
      throw new DebuggerError('The debuggee must be stopped at a breakpoint for that', 409);
    }
    return active;
  };

  const clearStoppedView = () => {
    session.status = 'running';
    session.stack = [];
    session.currentFrameIndex = null;
  };

  const stop = async () => {
    const active = requireSession();
    let settled = false;
    const grace = new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve();
        }
      }, DISCONNECT_GRACE_MS);
      // The disconnect terminates the whole debuggee, so it rides the root
      // channel even while the panel's control route points at a subprocess.
      sendOnChannel(active, 'disconnect', { terminateDebuggee: true }, DISCONNECT_GRACE_MS)
        .catch(() => {})
        .then(() => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve();
          }
        });
    });
    await grace;
    if (session === active) {
      await finishAfterTestEvents(active, null, 'stopped by the user');
    }
    return state();
  };

  const setBreakpoints = async (entry) => {
    const { path: breakpointPath, lines } = normalizeBreakpointPair(entry);
    breakpointsByPath.set(breakpointPath, lines);
    // During startup the `initialized` handler ships every stored file; live
    // runs get the delta right away on every channel the run owns.
    if (session && session.status !== 'starting') {
      await sendCurrentBreakpoints(session, breakpointPath);
    }
    broadcast();
    return state();
  };

  const continueRun = async () => {
    const active = requireStoppedSession();
    await sendRequest('continue', { threadId: active.threadId });
    clearStoppedView();
    broadcast();
    return state();
  };

  const controlStep = async (kind) => {
    const active = requireStoppedSession();
    if (!STEP_KINDS.has(kind)) {
      throw new DebuggerError(`Unknown step kind: ${kind}`, 400);
    }
    const command = kind === 'over' ? 'next' : kind === 'into' ? 'stepIn' : 'stepOut';
    await sendRequest(command, { threadId: active.threadId });
    clearStoppedView();
    broadcast();
    return state();
  };

  const evaluate = async (entry) => {
    const active = requireStoppedSession();
    if (!isPlainObject(entry) || !isString(entry.expression) || entry.expression.trim() === '') {
      throw new DebuggerError('evaluate needs a non-empty expression string', 400);
    }
    const topFrame = active.stack[0];
    if (topFrame?.dapId == null) {
      throw new DebuggerError('There is no stopped frame to evaluate on', 409);
    }
    try {
      const body = await sendRequest('evaluate', {
        expression: entry.expression,
        frameId: topFrame.dapId,
        context: 'repl',
      });
      return { result: isString(body?.result) ? clipString(body.result, STRING_MAX_CHARS) : null };
    } catch (error) {
      return { result: null, error: error instanceof DebuggerError ? error.message : String(error?.message ?? error) };
    }
  };

  // Children of one container variable, fetched when the panel expands it.
  // References only live while the debuggee stays stopped at the same frame;
  // the panel drops the tree on every resume, so a stale reference should be
  // impossible, but the adapter's own error still names it if it happens.
  const getVariables = async (entry) => {
    requireStoppedSession();
    const reference = entry?.reference;
    if (!Number.isInteger(reference) || reference <= 0) {
      throw new DebuggerError('The variable reference must be a positive integer', 400);
    }
    const body = await sendRequest('variables', { variablesReference: reference });
    return { variables: sanitizeVariables(body?.variables) };
  };

  const breakpointState = () =>
    [...breakpointsByPath.entries()].map(([breakpointPath, lines]) => ({ path: breakpointPath, lines }));

  const state = () => ({
    session: session == null ? null : {
      status: session.status,
      threadId: session.threadId,
      currentFrameIndex: session.currentFrameIndex,
      stack: session.stack,
      error: session.error,
      launch: session.launchEcho,
    },
    breakpoints: breakpointState(),
    lastExit: lastExit == null ? null : {
      exitCode: lastExit.exitCode,
      finishedAt: lastExit.finishedAt,
      closeReason: lastExit.closeReason,
      error: lastExit.error,
      adapterDiagnostics: lastExit.adapterDiagnostics,
      adapterLog: lastExit.adapterLog,
      launch: lastExit.launch,
    },
    outputTail: session ? session.outputTail : lastExit?.outputTail ?? [],
    // The pytest tree survives its run like the output tail does: the panel
    // reads results right after the process ends.
    tests: session != null
      ? (session.testsTracker == null ? null : testsProjection(session.testsTracker))
      : lastExit?.tests ?? null,
  });

  return {
    start,
    stop,
    continueRun,
    controlStep,
    setBreakpoints,
    evaluate,
    getVariables,
    state,
  };
};
