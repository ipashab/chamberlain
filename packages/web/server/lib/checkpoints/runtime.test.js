import fsDefault from 'node:fs';
import os from 'node:os';
import pathDefault from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCheckpointsRuntime } from './runtime.js';
import { createCheckpointStore } from './store.js';

/**
 * The runtime wires hub events to snapshot, registry and restore; the tests
 * pin that wiring: the gate order, what each turn pays for, the ref pinning
 * and unpinning around every exit path, and the restore/undo toggle. The
 * OpenCode client is exercised through a stubbed global fetch, the git
 * primitives through fakes, the store is real.
 */

const tempDirs = [];

const createDataDir = () => {
  const dir = fsDefault.mkdtempSync(pathDefault.join(os.tmpdir(), 'openchamber-checkpoints-runtime-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fsDefault.promises.rm(dir, { recursive: true, force: true })));
});

const editPart = (path, id = 'p_1') => ({
  id,
  type: 'tool',
  tool: 'edit',
  state: { status: 'completed', input: { path, oldString: 'foo', newString: 'bar' } },
});

const turnRecords = (parts) => ([
  { id: 'idle_1', type: 'idle', outcome: 'succeeded' },
  { id: 'a_1', type: 'assistant', content: parts, model: { providerID: 'prov', id: 'model-a' } },
  { id: 'u_1', type: 'user', text: 'Fix it' },
]);

const api = (pages) => vi.fn(async (input) => {
  const url = new URL(String(input));
  if (url.pathname === '/api/session/ses_1/message') {
    return new Response(JSON.stringify({ data: pages, cursor: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response(JSON.stringify({}), { status: 404 });
});

const idle = (directory = '/repo') => ({
  type: 'session.status',
  properties: { sessionID: 'ses_1', status: { type: 'idle' }, directory },
});

const busy = (directory = '/repo') => ({
  type: 'session.status',
  properties: { sessionID: 'ses_1', status: { type: 'busy' }, directory },
});

const userMessage = (createdAt = Number.MAX_SAFE_INTEGER) => ({
  type: 'message.updated',
  properties: { info: { sessionID: 'ses_1', role: 'user', time: { created: createdAt } } },
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

const TREE = 'f'.repeat(40);
const UNDO_TREE = 'e'.repeat(40);

const makeGit = (overrides = {}) => ({
  captureWorktreeSnapshot: vi.fn(async (directory, { refName }) => ({ directory, tree: TREE, refName, repoRoot: directory })),
  restoreSnapshotFiles: vi.fn(async () => ({ restored: ['a.py'], removed: [], skipped: [] })),
  deleteCheckpointRef: vi.fn(async () => true),
  ...overrides,
});

const makeRuntime = ({ git = makeGit(), dataDir = createDataDir(), broadcast = null, overrides = {} } = {}) => {
  const store = createCheckpointStore({ dataDir });
  const runtime = createCheckpointsRuntime({
    buildOpenCodeUrl: (fetchPath) => `http://opencode.test${fetchPath}`,
    getOpenCodeAuthHeaders: () => ({}),
    store,
    git,
    broadcast,
    getEnabled: () => true,
    ...overrides,
  });
  return { runtime, store, git };
};

describe('turn checkpoint capture', () => {
  it('records the turn with its pre-turn snapshot and broadcasts', async () => {
    const fetchMock = api(turnRecords([editPart('a.py')]));
    vi.stubGlobal('fetch', fetchMock);
    const broadcast = vi.fn();
    const { runtime, store, git } = makeRuntime({ broadcast });

    runtime.processPayload(busy());
    runtime.processPayload(idle());
    await settle();

    expect(git.captureWorktreeSnapshot).toHaveBeenCalledTimes(1);
    expect(git.captureWorktreeSnapshot).toHaveBeenCalledWith('/repo', {
      refName: expect.stringMatching(/^refs\/openchamber\/checkpoints\/ses_1\/\d+\/base$/),
    });
    const entries = await store.list('ses_1');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: 'u_1',
      userMessageID: 'u_1',
      directory: '/repo',
      tree: TREE,
      files: ['a.py'],
    });
    expect(broadcast).toHaveBeenCalledWith({
      type: 'openchamber:session-checkpoints',
      properties: { sessionID: 'ses_1' },
    });
  });

  it('skips the first turn after a restart, when nothing was armed', async () => {
    const fetchMock = api(turnRecords([editPart('a.py')]));
    vi.stubGlobal('fetch', fetchMock);
    const { runtime, store, git } = makeRuntime();

    runtime.processPayload(idle());
    await settle();

    expect(git.captureWorktreeSnapshot).not.toHaveBeenCalled();
    expect(await store.list('ses_1')).toEqual([]);
  });

  it('drops the armed ref when the turn touched no files', async () => {
    const fetchMock = api(turnRecords([]));
    vi.stubGlobal('fetch', fetchMock);
    const { runtime, store, git } = makeRuntime();

    runtime.processPayload(busy());
    runtime.processPayload(idle());
    await settle();

    expect(git.deleteCheckpointRef).toHaveBeenCalledWith('/repo', expect.stringMatching(/\/base$/));
    expect(await store.list('ses_1')).toEqual([]);
  });

  it('unpins the failed capture and stays armed for the next turn', async () => {
    let failing = true;
    const git = makeGit({
      captureWorktreeSnapshot: vi.fn(async (directory, { refName }) => {
        if (failing) throw new Error('not a repository');
        return { directory, tree: TREE, refName, repoRoot: directory };
      }),
    });
    const fetchMock = api(turnRecords([editPart('a.py')]));
    vi.stubGlobal('fetch', fetchMock);
    const { runtime, store } = makeRuntime({ git });

    runtime.processPayload(busy());
    runtime.processPayload(idle());
    await settle();
    expect(await store.list('ses_1')).toEqual([]);

    failing = false;
    runtime.processPayload(busy());
    runtime.processPayload(idle());
    await settle();
    expect(await store.list('ses_1')).toHaveLength(1);
  });

  it('stays quiet while disabled and for archived sessions', async () => {
    const broadcast = vi.fn();
    const { runtime, store, git } = makeRuntime({ broadcast, overrides: { getEnabled: () => false } });
    runtime.processPayload(busy());
    runtime.processPayload(idle('/repo'));
    await settle();
    expect(git.captureWorktreeSnapshot).not.toHaveBeenCalled();
    runtime.stop();

    const archived = makeRuntime({ overrides: { isSessionArchived: async () => true } });
    vi.stubGlobal('fetch', api(turnRecords([editPart('a.py')])));
    archived.runtime.processPayload(busy());
    archived.runtime.processPayload(idle());
    await settle();
    expect(await archived.store.list('ses_1')).toEqual([]);
    expect(archived.git.deleteCheckpointRef).toHaveBeenCalledWith('/repo', expect.stringMatching(/\/base$/));
  });

  it('retires a capture when a newer ask supersedes the turn it was armed for', async () => {
    const fetchMock = api(turnRecords([editPart('a.py')]));
    vi.stubGlobal('fetch', fetchMock);
    const { runtime, store, git } = makeRuntime();

    runtime.processPayload(busy());
    runtime.processPayload(userMessage());
    runtime.processPayload(idle());
    await settle();

    expect(git.deleteCheckpointRef).toHaveBeenCalledWith('/repo', expect.stringMatching(/\/base$/));
    expect(await store.list('ses_1')).toEqual([]);
  });

  it('ignores events once stopped and unpins what was armed', async () => {
    const fetchMock = api(turnRecords([editPart('a.py')]));
    vi.stubGlobal('fetch', fetchMock);
    const { runtime, store, git } = makeRuntime();

    runtime.processPayload(busy());
    runtime.stop();
    runtime.processPayload(idle());
    await settle();

    expect(git.deleteCheckpointRef).toHaveBeenCalledWith('/repo', expect.stringMatching(/\/base$/));
    expect(await store.list('ses_1')).toEqual([]);
  });
});

describe('restore and undo', () => {
  const seedEntry = async (store, { restored = null } = {}) => {
    await store.record('ses_1', {
      id: 'u_1',
      userMessageID: 'u_1',
      directory: '/repo',
      tree: TREE,
      baseRefName: 'refs/openchamber/checkpoints/ses_1/100/base',
      createdAt: 100,
      files: ['a.py'],
    });
    if (restored) await store.markRestored('ses_1', 'u_1', restored);
  };

  it('captures the displaced state, restores the files and records the undo', async () => {
    const { runtime, store, git } = makeRuntime();
    await seedEntry(store);

    const outcome = await runtime.restore('ses_1', 'u_1');
    expect(outcome.ok).toBe(true);
    expect(outcome.restored).toEqual(['a.py']);
    expect(git.captureWorktreeSnapshot).toHaveBeenCalledWith('/repo', {
      refName: 'refs/openchamber/checkpoints/ses_1/100/undo',
    });
    expect(git.restoreSnapshotFiles).toHaveBeenCalledWith('/repo', TREE, ['a.py']);
    const stored = await store.get('ses_1', 'u_1');
    expect(stored.restored).toMatchObject({
      tree: TREE,
      refName: 'refs/openchamber/checkpoints/ses_1/100/undo',
    });
  });

  it('toggles back from the undo snapshot on a second call', async () => {
    const git = makeGit({
      captureWorktreeSnapshot: vi.fn(async (directory, { refName }) => (
        { directory, tree: refName.endsWith('/undo') ? UNDO_TREE : TREE, refName, repoRoot: directory }
      )),
    });
    const { runtime, store } = makeRuntime({ git });
    await seedEntry(store);

    await runtime.restore('ses_1', 'u_1');
    const outcome = await runtime.restore('ses_1', 'u_1', { undo: true });
    expect(outcome.ok).toBe(true);
    expect(git.restoreSnapshotFiles).toHaveBeenLastCalledWith('/repo', UNDO_TREE, ['a.py']);
  });

  it('grades usage and reachability failures', async () => {
    const { runtime, store } = makeRuntime();
    await seedEntry(store);

    const untouched = await runtime.restore('ses_1', 'u_1', { undo: true });
    expect(untouched).toMatchObject({ ok: false, statusCode: 400 });

    expect(await runtime.restore('ses_1', 'missing')).toMatchObject({ ok: false, statusCode: 404 });
    expect(await runtime.restore('', 'u_1')).toMatchObject({ ok: false, statusCode: 400 });

    const gone = makeRuntime({ git: makeGit({ captureWorktreeSnapshot: vi.fn(async () => { throw new Error('deleted'); }) }) });
    await seedEntry(gone.store);
    expect(await gone.runtime.restore('ses_1', 'u_1')).toMatchObject({ ok: false, statusCode: 409 });

    const broken = makeRuntime({ git: makeGit({ restoreSnapshotFiles: vi.fn(async () => { throw new Error('boom'); }) }) });
    await seedEntry(broken.store);
    const failed = await broken.runtime.restore('ses_1', 'u_1');
    expect(failed).toMatchObject({ ok: false, statusCode: 500 });
    // The undo ref of a failed restore does not stay pinned.
    expect(broken.git.deleteCheckpointRef).toHaveBeenCalledWith('/repo', 'refs/openchamber/checkpoints/ses_1/100/undo');
  });

  it('unpins a superseded undo ref that differs from the fresh one', async () => {
    const { runtime, store, git } = makeRuntime();
    await seedEntry(store, {
      restored: { at: 50, tree: UNDO_TREE, refName: 'refs/openchamber/checkpoints/ses_1/100/undo-old' },
    });

    const outcome = await runtime.restore('ses_1', 'u_1');
    expect(outcome.ok).toBe(true);
    expect(git.deleteCheckpointRef).toHaveBeenCalledWith('/repo', 'refs/openchamber/checkpoints/ses_1/100/undo-old');
  });
});
