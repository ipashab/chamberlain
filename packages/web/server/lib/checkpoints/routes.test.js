import { describe, expect, it, vi } from 'vitest';
import { registerCheckpointRoutes } from './routes.js';

/** The routes translate the runtime's graded answers; the tests pin the
 * grades, the required fields and the shape the client parses. */

const makeApp = () => {
  const routes = [];
  const record = (method) => (routePath, ...handlers) => routes.push({ method, path: routePath, handler: handlers.at(-1) });
  return {
    routes,
    get: record('GET'),
    post: record('POST'),
    put: record('PUT'),
    delete: record('DELETE'),
  };
};

const makeRes = () => {
  const res = { statusCode: 200 };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    return res;
  };
  return res;
};

const findRoute = (app, method, routePath) => {
  const route = app.routes.find((entry) => entry.method === method && entry.path === routePath);
  if (!route) throw new Error(`route ${method} ${routePath} was not registered`);
  return route;
};

const callRoute = async (app, method, routePath, req = {}) => {
  const res = makeRes();
  await findRoute(app, method, routePath).handler(req, res);
  return res;
};

const runtimeOf = (overrides = {}) => ({
  list: vi.fn(async () => [{ id: 'u_1', userMessageID: 'u_1', files: ['a.py'] }]),
  restore: vi.fn(async () => ({ ok: true, checkpoint: 'u_1', restored: ['a.py'], removed: [], skipped: [] })),
  ...overrides,
});

describe('registerCheckpointRoutes', () => {
  it('requires a runtime at registration', () => {
    const app = makeApp();
    expect(() => registerCheckpointRoutes(app, {})).toThrow(/checkpoints runtime/);
  });

  it('lists a session registry and grades a missing sessionID', async () => {
    const app = makeApp();
    const checkpointsRuntime = runtimeOf();
    registerCheckpointRoutes(app, { checkpointsRuntime });

    const res = await callRoute(app, 'GET', '/api/openchamber/checkpoints', { query: { sessionID: 'ses_1' } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ sessionID: 'ses_1' });
    expect(res.body.checkpoints[0]).toMatchObject({ id: 'u_1', files: ['a.py'] });
    expect(checkpointsRuntime.list).toHaveBeenCalledWith('ses_1');

    const missing = await callRoute(app, 'GET', '/api/openchamber/checkpoints', { query: {} });
    expect(missing.statusCode).toBe(400);
    expect(missing.body.error).toBe('sessionID is required');
  });

  it('reports a registry read failure as a server error', async () => {
    const app = makeApp();
    const checkpointsRuntime = runtimeOf({ list: vi.fn(async () => { throw new Error('corrupt'); }) });
    registerCheckpointRoutes(app, { checkpointsRuntime });
    const res = await callRoute(app, 'GET', '/api/openchamber/checkpoints', { query: { sessionID: 'ses_1' } });
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('The checkpoint registry could not be read');
  });

  it('restores and grades the runtime answers', async () => {
    const app = makeApp();
    const checkpointsRuntime = runtimeOf();
    registerCheckpointRoutes(app, { checkpointsRuntime });

    const res = await callRoute(app, 'POST', '/api/openchamber/checkpoints/restore', {
      body: { sessionID: 'ses_1', checkpointID: 'u_1' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ sessionID: 'ses_1', checkpointID: 'u_1', restored: ['a.py'] });
    expect(checkpointsRuntime.restore).toHaveBeenCalledWith('ses_1', 'u_1', { undo: false });

    const unfields = await callRoute(app, 'POST', '/api/openchamber/checkpoints/restore', { body: {} });
    expect(unfields.statusCode).toBe(400);

    for (const [statusCode, expectedStatus] of [[400, 400], [404, 404], [409, 409], [500, 500]]) {
      const runtime = runtimeOf({ restore: vi.fn(async () => ({ ok: false, statusCode, message: 'no' })) });
      const gradedApp = makeApp();
      registerCheckpointRoutes(gradedApp, { checkpointsRuntime: runtime });
      const graded = await callRoute(gradedApp, 'POST', '/api/openchamber/checkpoints/restore', {
        body: { sessionID: 'ses_1', checkpointID: 'u_1', undo: true },
      });
      expect(graded.statusCode).toBe(expectedStatus);
      expect(graded.body.error).toBe('no');
    }
  });
});
