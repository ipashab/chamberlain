import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'path';

import { registerSessionGroupPresetsRoutes } from './routes.js';

const createRouteRegistry = () => {
  const routes = new Map();

  const record = (method) => (routePath, ...handlers) => {
    routes.set(`${method} ${routePath}`, handlers);
  };

  return {
    app: {
      get: record('GET'),
      post: record('POST'),
    },
    getRoute(method, routePath) {
      // Only the route handler itself is invoked; middleware (the JSON body
      // parser) runs inside the real server and is bypassed with a prefilled
      // req.body, the way assistants tests do it.
      const handlers = routes.get(`${method} ${routePath}`);
      return handlers[handlers.length - 1];
    },
  };
};

const createMockResponse = () => {
  let statusCode = 200;
  let body = null;

  return {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      body = payload;
      return this;
    },
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
  };
};

const preset = (folderId, defaultAgent, applyRule = 'ask') => ({
  folderId,
  defaultAgent,
  applyRule,
});

const snapshot = (presets, removed) => {
  const body = { version: 1, presets };
  if (removed) body.removed = removed;
  return body;
};

describe('session-group-presets routes', () => {
  let persisted;
  let routeRegistry;

  const register = () => {
    const fsPromises = {
      readFile: vi.fn(async () => {
        if (persisted === null) {
          const error = new Error('missing');
          error.code = 'ENOENT';
          throw error;
        }
        return persisted;
      }),
      mkdir: vi.fn(async () => {}),
      writeFile: vi.fn(async (_tempPath, contents) => {
        persisted = contents;
      }),
      rename: vi.fn(async () => {}),
      unlink: vi.fn(async () => {}),
    };
    registerSessionGroupPresetsRoutes(routeRegistry.app, {
      fsPromises,
      path,
      openchamberDataDir: '/data',
    });
    return fsPromises;
  };

  const callGet = async () => {
    const res = createMockResponse();
    await routeRegistry.getRoute('GET', '/api/openchamber/session-group-presets')(undefined, res);
    return res;
  };

  const callPost = async (body) => {
    const res = createMockResponse();
    await routeRegistry.getRoute('POST', '/api/openchamber/session-group-presets')({ body }, res);
    return res;
  };

  beforeEach(() => {
    persisted = null;
    routeRegistry = createRouteRegistry();
  });

  it('answers an empty snapshot when nothing is stored yet', async () => {
    register();
    const res = await callGet();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ version: 1, presets: {} });
  });

  it('saves a preset and reads it back', async () => {
    register();
    const saved = await callPost(snapshot({ f1: preset('f1', 'writer') }));
    expect(saved.statusCode).toBe(200);
    expect(saved.body).toEqual({ success: true });

    const read = await callGet();
    expect(read.statusCode).toBe(200);
    expect(read.body.presets.f1).toMatchObject({ folderId: 'f1', defaultAgent: 'writer', applyRule: 'ask' });
  });

  it('lets the incoming write win for the folder it names', async () => {
    register();
    await callPost(snapshot({ f1: preset('f1', 'writer') }));
    await callPost(snapshot({ f1: preset('f1', 'reviewer', 'never') }));
    const read = await callGet();
    expect(read.body.presets.f1).toMatchObject({ defaultAgent: 'reviewer', applyRule: 'never' });
  });

  it('rejects a preset whose folder id disagrees with the map key', async () => {
    register();
    const res = await callPost({ version: 1, presets: { f1: preset('other', 'x') } });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an invalid payload', async () => {
    register();
    const res = await callPost({ version: 1, presets: { '': { defaultAgent: 'x' } } });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an unknown apply rule', async () => {
    register();
    const res = await callPost(snapshot({ f1: preset('f1', 'writer', 'sometimes') }));
    expect(res.statusCode).toBe(400);
  });

  it('rejects a snapshot with the wrong version', async () => {
    register();
    const res = await callPost({ version: 2, presets: {} });
    expect(res.statusCode).toBe(400);
  });

  it('reports malformed stored state on read instead of an empty table', async () => {
    register();
    persisted = '{broken';
    const res = await callGet();
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBeTruthy();
  });

  it('repairs malformed stored state with a valid write', async () => {
    register();
    persisted = 'not json';
    const saved = await callPost(snapshot({ f1: preset('f1', 'writer') }));
    expect(saved.statusCode).toBe(200);
    const read = await callGet();
    expect(read.statusCode).toBe(200);
    expect(read.body.presets.f1).toMatchObject({ defaultAgent: 'writer' });
  });

  it('accepts a preset that only sets the apply rule', async () => {
    register();
    const saved = await callPost(snapshot({ f1: preset('f1', null, 'never') }));
    expect(saved.statusCode).toBe(200);
    const read = await callGet();
    expect(read.body.presets.f1.applyRule).toBe('never');
    expect(read.body.presets.f1.defaultAgent).toBeNull();
  });

  it('deletes the folders named in `removed` and keeps the rest', async () => {
    register();
    await callPost(snapshot({ f1: preset('f1', 'writer'), f2: preset('f2', 'reviewer') }));
    const removed = await callPost(snapshot({}, ['f1']));
    expect(removed.statusCode).toBe(200);
    const read = await callGet();
    expect(Object.keys(read.body.presets)).toEqual(['f2']);
  });

  it('a write without `removed` never deletes folders it did not mention', async () => {
    register();
    await callPost(snapshot({ f1: preset('f1', 'writer') }));
    await callPost(snapshot({ f2: preset('f2', 'reviewer') }));
    const read = await callGet();
    expect(Object.keys(read.body.presets).sort()).toEqual(['f1', 'f2']);
  });

  it('answers 500 and keeps the stored state when a save fails', async () => {
    const fsPromises = {
      readFile: vi.fn(async () => {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      }),
      mkdir: vi.fn(async () => {}),
      writeFile: vi.fn(async () => {}),
      rename: vi.fn(async () => { throw new Error('disk full'); }),
      unlink: vi.fn(async () => {}),
    };
    registerSessionGroupPresetsRoutes(routeRegistry.app, { fsPromises, path, openchamberDataDir: '/data' });
    const saved = await callPost(snapshot({ f1: preset('f1', 'writer') }));
    expect(saved.statusCode).toBe(500);
    expect(fsPromises.unlink).toHaveBeenCalledWith(expect.stringContaining('session-group-presets.json.tmp-'));
  });
});
