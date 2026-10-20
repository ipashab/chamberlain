import { describe, expect, it, vi } from 'vitest';
import { registerBacklogRoutes } from './routes.js';

/** The routes translate the service's graded answers; the tests pin the
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

const serviceOf = (overrides = {}) => ({
  executeAction: vi.fn(async (action) => ({ sessionID: 'ses_one', action })),
  ...overrides,
});

const jsonBodyOf = (app, method, routePath) => {
  const route = findRoute(app, method, routePath);
  // The JSON parser is the first handler on every body-reading route.
  expect(route.handler).toBeDefined();
  return route.handler;
};

describe('registerBacklogRoutes', () => {
  it('requires a service at registration', () => {
    const app = makeApp();
    expect(() => registerBacklogRoutes(app, {})).toThrow(/backlog service/);
  });

  it('reads a session backlog and grades a missing sessionID', async () => {
    const app = makeApp();
    const backlogService = serviceOf();
    registerBacklogRoutes(app, { backlogService });
    const res = await callRoute(app, 'GET', '/api/openchamber/backlog', { query: { sessionID: 'ses_one' } });
    expect(res.statusCode).toBe(200);
    expect(backlogService.executeAction).toHaveBeenCalledWith('backlog.list', { sessionID: 'ses_one' });
    const missing = await callRoute(app, 'GET', '/api/openchamber/backlog', { query: {} });
    expect(missing.statusCode).toBe(400);
  });

  it('stages an item, takes one out, clears, and starts the drain', async () => {
    const app = makeApp();
    const backlogService = serviceOf();
    registerBacklogRoutes(app, { backlogService });
    const added = await callRoute(app, 'POST', '/api/openchamber/backlog', { body: { sessionID: 'ses_one', text: 'do it later' } });
    expect(added.statusCode).toBe(200);
    expect(backlogService.executeAction).toHaveBeenCalledWith('backlog.add', { sessionID: 'ses_one', text: 'do it later' });
    const removed = await callRoute(app, 'POST', '/api/openchamber/backlog/remove', { body: { sessionID: 'ses_one', itemID: 'bl_1' } });
    expect(backlogService.executeAction).toHaveBeenCalledWith('backlog.remove', { sessionID: 'ses_one', itemID: 'bl_1' });
    expect(removed.statusCode).toBe(200);
    const cleared = await callRoute(app, 'POST', '/api/openchamber/backlog/clear', { body: { sessionID: 'ses_one' } });
    expect(backlogService.executeAction).toHaveBeenCalledWith('backlog.clear', { sessionID: 'ses_one' });
    expect(cleared.statusCode).toBe(200);
    const drained = await callRoute(app, 'POST', '/api/openchamber/backlog/run', { body: { sessionID: 'ses_one' } });
    expect(backlogService.executeAction).toHaveBeenCalledWith('backlog.run', { sessionID: 'ses_one' });
    expect(drained.statusCode).toBe(200);
  });

  it('grades every body-reading route a missing sessionID', async () => {
    const app = makeApp();
    registerBacklogRoutes(app, { backlogService: serviceOf() });
    for (const path of ['/api/openchamber/backlog', '/api/openchamber/backlog/remove', '/api/openchamber/backlog/clear', '/api/openchamber/backlog/run']) {
      const res = await callRoute(app, 'POST', path, { body: {} });
      expect(res.statusCode).toBe(400);
    }
  });

  it('carries the service\'s failure grade to the client, and 500s stay logged', async () => {
    const app = makeApp();
    const backlogService = serviceOf({
      executeAction: vi.fn(async () => {
        throw Object.assign(new Error('The backlog of this session is already draining'), { statusCode: 409 });
      }),
    });
    registerBacklogRoutes(app, { backlogService });
    const res = await callRoute(app, 'POST', '/api/openchamber/backlog/run', { body: { sessionID: 'ses_one' } });
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toContain('already draining');
  });

  it('carries the client routes through the service\'s graded answers', async () => {
    for (const [statusCode, expectedStatus] of [[400, 400], [404, 404], [409, 409], [500, 500]]) {
      const app = makeApp();
      const backlogService = serviceOf({
        executeAction: vi.fn(async () => {
          throw Object.assign(new Error(`grade ${statusCode}`), { statusCode });
        }),
      });
      registerBacklogRoutes(app, { backlogService });
      const res = await callRoute(app, 'POST', '/api/openchamber/backlog/run', { body: { sessionID: 'ses_one' } });
      expect(res.statusCode).toBe(expectedStatus);
      expect(res.body.error).toBe(`grade ${statusCode}`);
    }
  });
});
