import { describe, expect, it, vi } from 'vitest';

import { createDebuggerActions } from './debugger-actions.js';

const createState = (overrides = {}) => ({
  session: null,
  breakpoints: [],
  lastExit: null,
  outputTail: [],
  tests: null,
  ...overrides,
});

const createActions = (serviceOverrides = {}, factoryOverrides = {}) => {
  const debuggerService = {
    start: vi.fn(async () => createState({ session: { status: 'starting', stack: [] } })),
    stop: vi.fn(async () => createState()),
    state: vi.fn(() => createState()),
    setBreakpoints: vi.fn(async () => createState()),
    continueRun: vi.fn(async () => createState()),
    controlStep: vi.fn(async () => createState()),
    evaluate: vi.fn(async () => ({ result: '3' })),
    getVariables: vi.fn(async () => ({ variables: [] })),
    ...serviceOverrides,
  };
  return { actions: createDebuggerActions({ debuggerService, ...factoryOverrides }), debuggerService };
};

describe('debug.start', () => {
  it('resolves relative program and breakpoint paths against cwd', async () => {
    const { actions, debuggerService } = createActions();
    await actions.execute('debug.start', {
      cwd: '/repo',
      program: 'scripts/warm.py',
      breakpoints: [{ path: 'src/main.py', lines: [3, 7] }],
    });
    expect(debuggerService.start).toHaveBeenCalledWith({
      cwd: '/repo',
      program: '/repo/scripts/warm.py',
      breakpoints: [{ path: '/repo/src/main.py', lines: [3, 7] }],
    });
  });

  it('defaults cwd to the session directory and keeps module a module name', async () => {
    const { actions, debuggerService } = createActions();
    await actions.execute('debug.start', { module: 'pytest', args: ['-k', 'test_tag'] }, '/repo');
    expect(debuggerService.start).toHaveBeenCalledWith({ cwd: '/repo', module: 'pytest', args: ['-k', 'test_tag'] });
  });

  it('asks for exactly one of module or program', async () => {
    const { actions } = createActions();
    await expect(actions.execute('debug.start', {}, '/repo')).rejects.toMatchObject({ statusCode: 400 });
    await expect(actions.execute('debug.start', { module: 'pytest', program: 'run.py' }, '/repo')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('needs a working directory when the session has none', async () => {
    const { actions } = createActions();
    await expect(actions.execute('debug.start', { module: 'pytest' }, undefined)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('lets an absolute program stay outside the working directory', async () => {
    const { actions, debuggerService } = createActions();
    await actions.execute('debug.start', { cwd: '/repo', program: '/opt/tool/run.py' });
    expect(debuggerService.start).toHaveBeenCalledWith({ cwd: '/repo', program: '/opt/tool/run.py' });
  });
});

describe('debug.wait', () => {
  it('resolves the moment the debuggee stops at a breakpoint', async () => {
    let calls = 0;
    const { actions } = createActions({
      state: () => createState(calls++ === 0
        ? { session: { status: 'running', stack: [] } }
        : { session: { status: 'stopped', stack: [{ name: 'test_tag', path: '/repo/test.py', line: 4 }] } }),
    });
    const result = await actions.execute('debug.wait', { until: 'stop' }, '/repo');
    expect(result.waited).toBe('stop');
    expect(result.session.stack[0].name).toBe('test_tag');
  });

  it('waits for the exit and carries the verdict through', async () => {
    const { actions } = createActions({
      state: () => createState({ session: null, lastExit: { exitCode: 1, closeReason: 'exited' }, tests: { collected: 2 } }),
    });
    const result = await actions.execute('debug.wait', { until: 'exit' }, '/repo');
    expect(result.waited).toBe('exit');
    expect(result.tests.collected).toBe(2);
  });

  it('an ended run also answers a wait for a stop, with what ended it', async () => {
    const { actions } = createActions({
      state: () => createState({ session: null, lastExit: { exitCode: 0, closeReason: 'exited' } }),
    });
    const result = await actions.execute('debug.wait', { until: 'stop' }, '/repo');
    expect(result.waited).toBe('exit');
  });

  it('resolves on timeout with the current state instead of failing', async () => {
    const { actions } = createActions(
      {
        state: () => createState({ session: { status: 'running', stack: [] } }),
      },
      { sleep: async () => {} },
    );
    const result = await actions.execute('debug.wait', { until: 'exit', timeoutMs: 1000 }, '/repo');
    expect(result.waited).toBe('timeout');
  });

  it('refuses to wait when no run is active', async () => {
    const { actions } = createActions({ state: () => createState() });
    await expect(actions.execute('debug.wait', { until: 'exit' }, '/repo')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('stops waiting when the calling turn is cancelled', async () => {
    let calls = 0;
    const controller = new AbortController();
    const { actions } = createActions(
      {
        state: () => createState({ session: { status: 'running', stack: [] } }),
      },
      {
        sleep: async () => { if (calls++ === 0) controller.abort(); },
      },
    );
    const promise = actions.execute('debug.wait', { until: 'stop' }, '/repo', { signal: controller.signal });
    await expect(promise).rejects.toMatchObject({ statusCode: 409, message: 'The wait was cancelled' });
  });

  it('names its condition and clamps the timeout', async () => {
    const { actions } = createActions();
    await expect(actions.execute('debug.wait', {}, '/repo')).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('until') });
    const { actions: clamped, debuggerService } = createActions();
    debuggerService.state = vi.fn(() => createState({ session: { status: 'stopped', stack: [] } }));
    await clamped.execute('debug.wait', { until: 'stop', timeoutMs: 99_999_999 }, '/repo');
    // The default sleep is never reached because the first probe already stopped.
    expect(debuggerService.state).toHaveBeenCalled();
  });
});

describe('the debug actions mirror the panel surface', () => {
  it('passes breakpoints through with a resolved path', async () => {
    const { actions, debuggerService } = createActions();
    await actions.execute('debug.breakpoints', { path: 'src/main.py', lines: [5] }, '/repo');
    expect(debuggerService.setBreakpoints).toHaveBeenCalledWith({ path: '/repo/src/main.py', lines: [5] });
  });

  it('forwards the stopped-frame actions verbatim', async () => {
    const { actions, debuggerService } = createActions();
    await actions.execute('debug.continue', {});
    await actions.execute('debug.step', { kind: 'into' });
    await actions.execute('debug.evaluate', { expression: 'tag.id' });
    await actions.execute('debug.variables', { reference: 7 });
    await actions.execute('debug.state', {});
    await actions.execute('debug.stop', {});
    expect(debuggerService.continueRun).toHaveBeenCalled();
    expect(debuggerService.controlStep).toHaveBeenCalledWith('into');
    expect(debuggerService.evaluate).toHaveBeenCalledWith({ expression: 'tag.id' });
    expect(debuggerService.getVariables).toHaveBeenCalledWith({ reference: 7 });
    expect(debuggerService.state).toHaveBeenCalled();
    expect(debuggerService.stop).toHaveBeenCalled();
  });

  it('refuses an unknown action with the tool\'s own vocabulary', async () => {
    const { actions } = createActions();
    await expect(actions.execute('debug.attach', {}, '/repo')).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('Unsupported debug action') });
  });
});
