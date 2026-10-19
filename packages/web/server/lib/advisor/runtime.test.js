import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAdvisorRuntime } from './runtime.js';

/**
 * The advisor's findings live in OpenChamber's own session metadata store,
 * like the recap. `persistAdvisor` is the seam; the tests here pin the
 * wiring around it: the gate order, the reads the turn pays for, the
 * deterministic passes that run without a model, and the retire/abort paths
 * that keep a stored review describing the newest turn only.
 */

const runtimes = [];

const editPart = (path, oldString, newString) => ({
  id: `p_${path}`,
  type: 'tool',
  tool: 'edit',
  state: { status: 'completed', input: { path, oldString, newString } },
});

const sessionRecord = () => ({ id: 'ses_1', location: { directory: '/repo' } });

/** Newest-first records: the idle marker closes the turn the edit belongs to. */
const turnRecords = (parts, humanText = 'Fix the config', assistantId = 'a_1') => ([
  { id: 'idle_1', type: 'idle', outcome: 'succeeded' },
  {
    id: assistantId,
    type: 'assistant',
    content: parts,
    model: { providerID: 'prov', id: 'model-a' },
    time: { created: 20, completed: 21 },
  },
  { id: 'u_1', type: 'user', text: humanText },
]);

const api = (pages, session = sessionRecord()) => vi.fn(async (input) => {
  const url = new URL(String(input));
  if (url.pathname === '/api/session/ses_1') {
    return new Response(JSON.stringify({ data: session }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url.pathname === '/api/session/ses_1/message') {
    return new Response(JSON.stringify({ data: pages, cursor: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response(JSON.stringify({}), { status: 404 });
});

const idle = (sessionId = 'ses_1') => ({
  type: 'session.status',
  properties: { sessionID: sessionId, status: { type: 'idle' }, directory: '/repo' },
});

const busy = (sessionId = 'ses_1') => ({
  type: 'session.status',
  properties: { sessionID: sessionId, status: { type: 'busy' }, directory: '/repo' },
});

const userMessage = (sessionId = 'ses_1', createdAt = Number.MAX_SAFE_INTEGER) => ({
  type: 'message.updated',
  properties: { info: { sessionID: sessionId, role: 'user', time: { created: createdAt } } },
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

const baseOverrides = {
  getEnabled: () => true,
  readUserRulesFile: async () => null,
  readFile: async () => { throw new Error('no anchor read expected'); },
  resolvePath: (directory, filePath) => `${directory}/${filePath}`,
};

const smallModel = (overrides = {}) => async () => ({
  describeSmallModel: async () => ({ providerID: 'other', modelID: 'small', inputCharBudget: 30_000, localEndpoint: false }),
  generateSmallModelText: async () => ({ text: '[]' }),
  ...overrides,
});

const makeRuntime = (overrides = {}) => {
  const runtime = createAdvisorRuntime({
    buildOpenCodeUrl: (fetchPath) => `http://opencode.test${fetchPath}`,
    getOpenCodeAuthHeaders: () => ({}),
    getSmallModelService: smallModel(),
    persistAdvisor: vi.fn(async () => undefined),
    ...baseOverrides,
    ...overrides,
  });
  runtimes.push(runtime);
  return runtime;
};

afterEach(() => {
  while (runtimes.length > 0) runtimes.pop().stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('advisor runtime wiring', () => {
  it('does no work and reaches no service while no metadata store is injected', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const runtime = makeRuntime({ persistAdvisor: null });

    runtime.processPayload(idle());
    runtime.processPayload(idle());
    await settle();

    expect(log.mock.calls.filter(([line]) => String(line).includes('[advisor] parked'))).toHaveLength(1);
  });

  it('ignores everything after stop', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const runtime = makeRuntime({ persistAdvisor: null });

    runtime.stop();
    runtime.processPayload(idle());
    await settle();
  });

  it('reads nothing while the setting is off', async () => {
    const fetchMock = api(turnRecords([editPart('a.py', 'foo', 'value = 1  # type: ignore\n')]));
    vi.stubGlobal('fetch', fetchMock);
    const runtime = makeRuntime({ getEnabled: () => false });

    runtime.processPayload(idle());
    await settle();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves an archived session alone after reading the record', async () => {
    const fetchMock = api(turnRecords([editPart('a.py', 'foo', 'bar')]));
    vi.stubGlobal('fetch', fetchMock);
    const persistAdvisor = vi.fn(async () => undefined);
    const runtime = makeRuntime({ persistAdvisor, isSessionArchived: async (id) => id === 'ses_1' });

    runtime.processPayload(idle());
    await settle();

    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual(['/api/session/ses_1']);
    expect(persistAdvisor).not.toHaveBeenCalled();
  });

  it('writes the deterministic findings of a turn with a rule hit', async () => {
    const fetchMock = api(turnRecords([editPart('a.py', 'foo', 'value = 1  # type: ignore\n')], 'Исправь конфиг'));
    vi.stubGlobal('fetch', fetchMock);
    const writeFile = async (resolved) => (resolved === '/repo/a.py' ? 'value = 1  # type: ignore\n' : null);
    const persistAdvisor = vi.fn(async () => undefined);
    const generate = vi.fn(async ({ system, prompt }) => {
      expect(system).toContain('Russian');
      expect(prompt).toContain('Исправь конфиг');
      expect(prompt).toContain('type: ignore');
      return { text: '[]' };
    });
    const runtime = makeRuntime({
      persistAdvisor,
      readFile: writeFile,
      getSmallModelService: smallModel({ generateSmallModelText: generate }),
    });

    runtime.processPayload(idle());
    await settle();

    expect(persistAdvisor).toHaveBeenCalledTimes(1);
    const [sessionId, directory, advisor] = persistAdvisor.mock.calls[0];
    expect(sessionId).toBe('ses_1');
    expect(directory).toBe('/repo');
    expect(advisor.forMessageID).toBe('a_1');
    expect(advisor.at).toBeGreaterThan(0);
    expect(advisor.findings).toEqual([{
      severity: 'P2',
      source: 'rules',
      note: expect.stringContaining('type-ignore'),
      file: 'a.py',
    }]);
  });

  it('verifies anchors against the file on disk and flags a missing edit as P1', async () => {
    const fetchMock = api(turnRecords([editPart('a.py', 'def broken():', 'def fixed():')]));
    vi.stubGlobal('fetch', fetchMock);
    const writeFile = async () => 'def broken():\n    pass\n';
    const persistAdvisor = vi.fn(async () => undefined);
    const runtime = makeRuntime({ persistAdvisor, readFile: writeFile });

    runtime.processPayload(idle());
    await settle();

    const advisor = persistAdvisor.mock.calls[0][2];
    expect(advisor.findings).toEqual([{
      severity: 'P1',
      source: 'anchor',
      note: expect.stringContaining('did not take'),
      file: 'a.py',
    }]);
  });

  it('adds the model\u2019s findings and wraps no findings in silence', async () => {
    const fetchMock = api(turnRecords([editPart('a.py', 'old', 'clean new text\n')]));
    vi.stubGlobal('fetch', fetchMock);
    const writeFile = async () => 'clean new text\n';
    const persistAdvisor = vi.fn(async () => undefined);
    const runtime = makeRuntime({
      persistAdvisor,
      readFile: writeFile,
      getSmallModelService: smallModel({
        generateSmallModelText: vi.fn(async () => ({
          text: 'thoughts\n```json\n[{"severity":"P1","note":"The retry loop still sleeps in seconds, not in attempts.","file":"a.py"}]\n```',
        })),
      }),
    });

    runtime.processPayload(idle());
    await settle();

    const advisor = persistAdvisor.mock.calls[0][2];
    expect(advisor.findings).toEqual([{
      severity: 'P1',
      source: 'model',
      note: 'The retry loop still sleeps in seconds, not in attempts.',
      file: 'a.py',
    }]);
  });

  it('writes nothing for a turn without file-changing calls', async () => {
    const fetchMock = api(turnRecords([{ type: 'text', text: 'done' }]));
    vi.stubGlobal('fetch', fetchMock);
    const persistAdvisor = vi.fn(async () => undefined);
    const runtime = makeRuntime({ persistAdvisor });

    runtime.processPayload(idle());
    await settle();

    expect(persistAdvisor).not.toHaveBeenCalled();
    // One page read covered the whole turn.
    const paths = fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname);
    expect(paths).toEqual(['/api/session/ses_1', '/api/session/ses_1/message']);
  });

  it('deletes the stored review the moment new work starts', async () => {
    const fetchMock = api(turnRecords([editPart('a.py', 'foo', 'value = 1  # type: ignore\n')]));
    vi.stubGlobal('fetch', fetchMock);
    const writeFile = async () => 'value = 1  # type: ignore\n';
    const persistAdvisor = vi.fn(async () => undefined);
    const runtime = makeRuntime({ persistAdvisor, readFile: writeFile });

    runtime.processPayload(idle());
    await settle();
    expect(persistAdvisor).toHaveBeenCalledTimes(1);

    runtime.processPayload(busy());
    await settle();

    expect(persistAdvisor).toHaveBeenCalledTimes(2);
    expect(persistAdvisor.mock.calls[1].slice(0, 2)).toEqual(['ses_1', '/repo']);
    expect(persistAdvisor.mock.calls[1][2]).toBeNull();
  });

  it('aborts a run whose session receives a newer user message', async () => {
    const aborts = [];
    vi.stubGlobal('fetch', vi.fn((input, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        aborts.push(new URL(String(input)).pathname);
        reject(new Error('aborted'));
      });
    })));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const persistAdvisor = vi.fn(async () => undefined);
    const runtime = makeRuntime({ persistAdvisor });

    runtime.processPayload(idle());
    await settle();
    runtime.processPayload(userMessage());
    await settle();

    expect(persistAdvisor).not.toHaveBeenCalled();
    expect(aborts.length).toBeGreaterThan(0);
  });

  it('skips the model review when the small model is the session\u2019s own local model', async () => {
    const fetchMock = api(turnRecords([editPart('a.py', 'foo', 'value = 1  # type: ignore\n')]));
    vi.stubGlobal('fetch', fetchMock);
    const generate = vi.fn(async () => ({ text: '[]' }));
    const runtime = makeRuntime({
      readFile: async () => 'value = 1  # type: ignore\n',
      getSmallModelService: async () => ({
        describeSmallModel: async () => ({ providerID: 'prov', modelID: 'model-a', inputCharBudget: 30_000, localEndpoint: true }),
        generateSmallModelText: generate,
      }),
    });

    runtime.processPayload(idle());
    await settle();

    expect(generate).not.toHaveBeenCalled();
  });
});
