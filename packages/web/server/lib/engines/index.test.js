import { describe, expect, test } from 'vitest';

import { BUILTIN_OPENCODE_DESCRIPTOR } from './descriptor.js';
import { createEnginesRuntime } from './index.js';

const quiet = { warn: () => {}, log: () => {}, error: () => {} };
const flush = () => new Promise((resolve) => { setTimeout(resolve, 5); });

const descriptor = (overrides = {}) => JSON.stringify({
  apiVersion: 1,
  id: 'codex',
  name: 'Codex',
  protocol: 'opencode-v1',
  endpoint: { healthPath: '/global/health' },
  capabilities: ['sessions', 'streaming'],
  ...overrides,
});

/**
 * A runtime over a mutable in-memory filesystem and a mutable env: the two
 * things an operator actually changes (a dropped-in file, OC_ENGINE) must be
 * observable through the runtime without a restart.
 */
const runtimeWith = ({ files = {}, env = {}, ...rest } = {}) => {
  const calls = { readdir: 0, fetch: 0, settingsReads: 0 };
  const runtime = createEnginesRuntime({
    env,
    logger: quiet,
    registryCacheMs: 10,
    probeCacheMs: 10,
    fsPromises: {
      readdir: async () => {
        calls.readdir += 1;
        return Object.keys(files);
      },
      readFile: async (file) => {
        const name = file.split('/').pop();
        const text = files[name];
        if (text === undefined) {
          const error = new Error('missing');
          error.code = 'ENOENT';
          throw error;
        }
        return text;
      },
    },
    getEngineBaseUrl: () => 'http://127.0.0.1:4096',
    getEngineAuthHeaders: () => ({}),
    fetchImpl: async () => {
      calls.fetch += 1;
      return { ok: true, status: 200, json: async () => ({ version: '1.0.0' }) };
    },
    ...rest,
  });
  return { runtime, calls, files, env };
};

describe('engines runtime — the default world', () => {
  test('no descriptor directory: builtin opencode, nothing requested', async () => {
    const { runtime } = runtimeWith({ files: { unknown: 'not json' } });
    const snapshot = await runtime.getSnapshot();
    expect(snapshot.active.id).toBe('opencode');
    expect(snapshot.requestedId).toBe(null);
    expect(snapshot.activeReason).toBe('only-one');
    expect(snapshot.warnings).toEqual([]);
  });

  test('getCachedSnapshot is null before warmup (no fabricated defaults in /health)', () => {
    const { runtime } = runtimeWith({});
    expect(runtime.getCachedSnapshot()).toBe(null);
  });
});

describe('engines runtime — stale-while-revalidate', () => {
  test('a stale sync read returns the old value and refreshes in the background', async () => {
    let clock = 0;
    const { runtime, calls } = runtimeWith({ files: {}, now: () => clock });
    await runtime.getSnapshot();
    expect(calls.readdir).toBe(1);

    clock = 11;
    const stale = runtime.getCachedSnapshot();
    expect(stale).not.toBe(null);
    await flush();
    expect(calls.readdir).toBeGreaterThan(1);
  });

  test('one refresh at a time: concurrent stale reads do not pile up', async () => {
    let clock = 0;
    const { runtime, calls } = runtimeWith({ files: {}, now: () => clock });
    await runtime.getSnapshot();
    clock = 11;
    runtime.getCachedSnapshot();
    runtime.getCachedSnapshot();
    runtime.getCachedSnapshot();
    await flush();
    expect(calls.readdir).toBe(2);
  });

  test('a descriptor dropped into the directory shows up within one cache period', async () => {
    let clock = 0;
    const { runtime, files } = runtimeWith({ files: {}, now: () => clock });
    await runtime.getSnapshot();
    expect(runtime.getCachedSnapshot().engines.map((e) => e.id)).toEqual(['opencode']);

    files['codex.json'] = descriptor();
    clock += 11;
    runtime.getCachedSnapshot(); // stale → background refresh
    await flush();
    expect(runtime.getCachedSnapshot().engines.map((e) => e.id)).toEqual(['codex', 'opencode']);
    expect(runtime.getCachedSnapshot().active.id).toBe('opencode'); // builtin stays default
  });
});

describe('engines runtime — the proxy seam (getActiveEngineOwnUrl)', () => {
  test('without a declared URL the seam stays null (legacy routing, byte for byte)', async () => {
    let clock = 0;
    const { runtime } = runtimeWith({ files: { 'codex.json': descriptor() }, now: () => clock });
    await runtime.getSnapshot();
    expect(runtime.getActiveEngineOwnUrl()).toBe(null);
  });

  test('an INACTIVE engine declaring a URL never leaks into the seam', async () => {
    let clock = 0;
    const { runtime } = runtimeWith({
      files: { 'codex.json': descriptor({ endpoint: { healthPath: '/global/health', url: 'http://codex-engine:4096/' } }) },
      now: () => clock,
    });
    await runtime.getSnapshot();
    expect(runtime.getActiveEngineOwnUrl()).toBe(null); // builtin is active, not codex
  });

  test('OC_ENGINE reroutes the proxy target within one cache period, no restart', async () => {
    let clock = 0;
    const { runtime, env } = runtimeWith({
      env: {},
      files: { 'codex.json': descriptor({ endpoint: { healthPath: '/global/health', url: 'http://codex-engine:4096' } }) },
      now: () => clock,
    });
    await runtime.getSnapshot();
    expect(runtime.getActiveEngineOwnUrl()).toBe(null);

    env.OC_ENGINE = 'codex';
    clock += 11;
    runtime.getActiveEngineOwnUrl(); // stale → refresh in flight
    await flush();
    expect(runtime.getActiveEngineOwnUrl()).toBe('http://codex-engine:4096');
  });

  test('switching OC_ENGINE back to the builtin clears the seam to null', async () => {
    let clock = 0;
    const { runtime, env } = runtimeWith({
      env: { OC_ENGINE: 'codex' },
      files: { 'codex.json': descriptor({ endpoint: { healthPath: '/global/health', url: 'http://codex-engine:4096' } }) },
      now: () => clock,
    });
    await runtime.getSnapshot();
    expect(runtime.getActiveEngineOwnUrl()).toBe('http://codex-engine:4096');

    env.OC_ENGINE = 'opencode';
    clock += 11;
    runtime.getActiveEngineOwnUrl();
    await flush();
    expect(runtime.getActiveEngineOwnUrl()).toBe(null);
  });
});

describe('engines runtime — probeActive', () => {
  test('an engine declaring a URL is probed there; the host address answers for the builtin', async () => {
    let clock = 0;
    const { runtime, calls, env } = runtimeWith({
      env: { OC_ENGINE: 'codex' },
      files: { 'codex.json': descriptor({ endpoint: { healthPath: '/global/health', url: 'http://codex-engine:4096' } }) },
      now: () => clock,
    });
    const first = await runtime.probeActive();
    expect(first.probe.baseUrl).toBe('http://codex-engine:4096');
    expect(first.probe.source).toBe('descriptor');
    expect(first.probe.healthPath).toBe('/global/health');
    expect(first.cached).toBe(false);

    env.OC_ENGINE = 'opencode';
    await runtime.probeActive({ force: true });
    const builtin = await runtime.probeActive({ force: true });
    expect(builtin.probe.baseUrl).toBe('http://127.0.0.1:4096');
    expect(builtin.probe.source).toBe('host');
    expect(calls.fetch).toBe(3);
  });

  test('probe answers are cached briefly (the UI polls; the engine should not)', async () => {
    let clock = 0;
    const { runtime, calls } = runtimeWith({ env: { OC_ENGINE: 'codex' }, files: { 'codex.json': descriptor() }, now: () => clock });
    await runtime.probeActive();
    const cached = await runtime.probeActive();
    expect(cached.cached).toBe(true);
    expect(calls.fetch).toBe(1);

    clock += 11;
    const fresh = await runtime.probeActive();
    expect(fresh.cached).toBe(false);
    expect(calls.fetch).toBe(2);
  });

  test('force bypasses caches on both layers (the operator "check it now" path)', async () => {
    const { runtime, calls } = runtimeWith({
      env: { OC_ENGINE: 'codex' },
      files: { 'codex.json': descriptor() },
    });
    await runtime.getSnapshot();
    await runtime.probeActive({ force: true });
    await runtime.probeActive({ force: true });
    expect(calls.fetch).toBe(2);
  });
});

describe('engines runtime — registerRoutes', () => {
  const fakeApp = () => {
    const handlers = new Map();
    return {
      handlers,
      get: (path, handler) => handlers.set(path, handler),
    };
  };

  const fakeRes = () => {
    const res = { statusCode: 200, body: null, status(code) { res.statusCode = code; return res; }, json(payload) { res.body = payload; return res; } };
    return res;
  };

  test('mounts the engine routes and warms the snapshot for /health', async () => {
    const { runtime } = runtimeWith({});
    const app = fakeApp();
    runtime.registerRoutes(app);
    expect([...app.handlers.keys()].sort()).toEqual([
      '/api/openchamber/engines',
      '/api/openchamber/engines/active',
    ]);
    await flush();
    expect(runtime.getCachedSnapshot()).not.toBe(null);
  });

  test('GET /api/openchamber/engines answers the snapshot; refresh=1 forces a reload', async () => {
    let clock = 0;
    const { runtime, files, calls } = runtimeWith({ files: {}, now: () => clock });
    const app = fakeApp();
    runtime.registerRoutes(app);
    await flush();

    await app.handlers.get('/api/openchamber/engines')({ query: {} }, fakeRes());
    const firstReaddir = calls.readdir;
    const firstBody = app.handlers.size; // route registered once, answered once
    expect(firstBody).toBe(2);
    expect(firstReaddir).toBeGreaterThan(0);

    files['codex.json'] = descriptor();
    await runtime.getSnapshot({ force: true });
    const res = fakeRes();
    await app.handlers.get('/api/openchamber/engines')({ query: { refresh: '1' } }, res);
    expect(res.body.engines.map((e) => e.id)).toEqual(['codex', 'opencode']);
    expect(res.statusCode).toBe(200);
  });

  test('GET /api/openchamber/engines/active answers the probe payload', async () => {
    const { runtime } = runtimeWith({});
    const app = fakeApp();
    runtime.registerRoutes(app);
    await flush();

    const res = fakeRes();
    await app.handlers.get('/api/openchamber/engines/active')({ query: {} }, res);
    expect(res.body.engine.id).toBe('opencode');
    expect(res.body.probe.ok).toBe(true);
    expect(res.statusCode).toBe(200);
  });

  test('a directory read failure surfaces as warnings, never as a 500', async () => {
    const runtime = createEnginesRuntime({
      env: {},
      logger: quiet,
      fsPromises: {
        readdir: async () => { throw new Error('kaboom'); },
        readFile: async () => '{}}',
      },
      getEngineBaseUrl: () => 'http://127.0.0.1:4096',
      getEngineAuthHeaders: () => ({}),
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    });
    const app = fakeApp();
    runtime.registerRoutes(app);
    await flush();
    const res = fakeRes();
    await app.handlers.get('/api/openchamber/engines')({ query: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.warnings.join(' ')).toContain('kaboom');
    // The builtin keeps the workbench standing: failures degrade to warnings.
    expect(res.body.active.id).toBe('opencode');
  });

  test('registerRoutes logs directory problems and still mounts routes', async () => {
    const lines = [];
    const runtime = createEnginesRuntime({
      env: {},
      logger: { warn: (line) => lines.push(line), log: () => {}, error: () => {} },
      fsPromises: {
        readdir: async () => { throw new Error('kaboom'); },
        readFile: async () => '{}}',
      },
      getEngineBaseUrl: () => 'http://127.0.0.1:4096',
      getEngineAuthHeaders: () => ({}),
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    });
    const app = fakeApp();
    runtime.registerRoutes(app);
    await flush();
    expect(app.handlers.size).toBe(2);
    expect(runtime.getCachedSnapshot()).not.toBe(null);
    expect(lines.join(' ')).toContain('Cannot read engine directory');
  });
});
