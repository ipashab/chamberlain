import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerConfluenceRoutes } from './routes.js';
import { ConfluenceError } from './client.js';
import { createConfluenceConfigStore } from './config-store.js';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const makeStore = async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-confluence-routes-'));
  temporaryDirectories.push(dataDir);
  return createConfluenceConfigStore({ fsPromises: fs, path, dataDir });
};

const makeApp = () => {
  const routes = [];
  // Registration may pass route middleware (express.json) before the handler;
  // the last argument is the handler the tests invoke.
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
  // Express answers 200 unless a handler calls res.status; the routes
  // follow that convention, so the double starts at the default.
  const res = { statusCode: 200 };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    return res;
  };
  res.set = (name, value) => {
    res.headers = { ...(res.headers ?? {}), [name]: value };
    return res;
  };
  res.send = (payload) => {
    res.body = payload;
    return res;
  };
  res.end = () => res;
  return res;
};

const callRoute = async (app, method, routePath, req = {}) => {
  const res = makeRes();
  const route = app.routes.find((entry) => entry.method === method && entry.path === routePath);
  if (!route) throw new Error(`route ${method} ${routePath} was not registered`);
  await route.handler(req, res);
  return res;
};

const connectedStore = async () => {
  const store = await makeStore();
  await store.save({ origin: 'https://confluence.example.com', token: 'CONF-secret', verifySsl: false });
  return store;
};

const pageRequestBody = () => ({
  id: '9001',
  title: 'Release checklist',
  space: { key: 'DEMO', name: 'Demo space' },
  version: { number: 7, when: '2026-10-10T10:00:00.000+0300' },
  history: null,
  body: { view: { value: '<h1>Ready to ship</h1>' } },
  _links: { webui: '/spaces/DEMO/pages/9001' },
});

describe('registerConfluenceRoutes', () => {
  it('needs its config store', () => {
    expect(() => registerConfluenceRoutes(makeApp(), {})).toThrow('confluence routes need a config store');
  });

  it('reads an unconfigured connection as the card first sees it', async () => {
    const store = await makeStore();
    const app = makeApp();
    registerConfluenceRoutes(app, { confluenceConfigStore: store });
    const res = await callRoute(app, 'GET', '/api/openchamber/confluence');
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ configured: false });
  });

  it('saves a connection, checks it, and never answers the token', async () => {
    const store = await makeStore();
    const app = makeApp();
    const request = vi.fn(async ({ path }) => {
      expect(path).toBe('/rest/api/user/current');
      return { displayName: 'a.coder' };
    });
    registerConfluenceRoutes(app, { confluenceConfigStore: store, createRequest: () => request });

    const res = await callRoute(app, 'PUT', '/api/openchamber/confluence', {
      body: { origin: 'https://confluence.example.com', token: 'CONF-secret', verifySsl: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      configured: true,
      origin: 'https://confluence.example.com',
      hasToken: true,
      verifySsl: false,
      connectionCheck: 'ok',
    });
    expect(JSON.stringify(res.body)).not.toContain('CONF-secret');
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      config: { origin: 'https://confluence.example.com', token: 'CONF-secret', verifySsl: false },
    }));

    const reading = await callRoute(app, 'GET', '/api/openchamber/confluence');
    expect(reading.body).toEqual({
      configured: true,
      origin: 'https://confluence.example.com',
      hasToken: true,
      verifySsl: false,
    });
  });

  it('reports a rejected token as the save answer, kind carried from the client', async () => {
    const store = await makeStore();
    const app = makeApp();
    const request = vi.fn(async () => { throw new ConfluenceError('unauthorized', 'the token was rejected', 401); });
    registerConfluenceRoutes(app, { confluenceConfigStore: store, createRequest: () => request });

    const res = await callRoute(app, 'PUT', '/api/openchamber/confluence', {
      body: { origin: 'https://confluence.example.com', token: 'CONF-bad' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ configured: true, connectionCheck: 'unauthorized' });
  });

  it('drops the connection on delete', async () => {
    const store = await connectedStore();
    const app = makeApp();
    registerConfluenceRoutes(app, { confluenceConfigStore: store });
    const res = await callRoute(app, 'DELETE', '/api/openchamber/confluence');
    expect(res.body).toEqual({ configured: false });
  });

  describe('page view', () => {
    it('refuses a reference that is not a page id', async () => {
      const store = await connectedStore();
      const app = makeApp();
      registerConfluenceRoutes(app, { confluenceConfigStore: store });
      const res = await callRoute(app, 'GET', '/api/openchamber/confluence/pages/view', { query: { id: 'DEMO' } });
      expect(res.statusCode).toBe(400);
      expect(res.body).toMatchObject({ kind: 'bad-ref' });
    });

    it('answers unconfigured before it ever asks the instance', async () => {
      const store = await makeStore();
      const app = makeApp();
      registerConfluenceRoutes(app, { confluenceConfigStore: store });
      const res = await callRoute(app, 'GET', '/api/openchamber/confluence/pages/view', { query: { id: '9001' } });
      expect(res.statusCode).toBe(409);
      expect(res.body).toMatchObject({ kind: 'unconfigured' });
    });

    it('answers the page view the reader reads, without the token', async () => {
      const store = await connectedStore();
      const app = makeApp();
      const request = vi.fn(async () => pageRequestBody());
      registerConfluenceRoutes(app, { confluenceConfigStore: store, createRequest: () => request });

      const res = await callRoute(app, 'GET', '/api/openchamber/confluence/pages/view', { query: { id: '9001' } });
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({ id: '9001', title: 'Release checklist', truncated: false });
      expect(JSON.stringify(res.body)).not.toContain('CONF-secret');
    });

    it('carries the not-found kind the client words itself', async () => {
      const store = await connectedStore();
      const app = makeApp();
      const request = vi.fn(async () => { throw new ConfluenceError('not-found', 'no such page', 404); });
      registerConfluenceRoutes(app, { confluenceConfigStore: store, createRequest: () => request });
      const res = await callRoute(app, 'GET', '/api/openchamber/confluence/pages/view', { query: { id: '9001' } });
      expect(res.statusCode).toBe(404);
      expect(res.body).toMatchObject({ kind: 'not-found' });
    });

    it('carries an unreachable instance as the client words it', async () => {
      const store = await connectedStore();
      const app = makeApp();
      const request = vi.fn(async () => { throw new ConfluenceError('unauthorized', 'rejected', 401); });
      registerConfluenceRoutes(app, { confluenceConfigStore: store, createRequest: () => request });
      const res = await callRoute(app, 'GET', '/api/openchamber/confluence/pages/view', { query: { id: '9001' } });
      expect(res.statusCode).toBe(502);
      expect(res.body).toMatchObject({ kind: 'unauthorized' });
    });
  });

  describe('page search', () => {
    it('answers the search rows and clamps the limit', async () => {
      const store = await connectedStore();
      const app = makeApp();
      const request = vi.fn(async () => ({ results: [{ id: '9001', title: 'Release checklist' }] }));
      registerConfluenceRoutes(app, { confluenceConfigStore: store, createRequest: () => request });

      const res = await callRoute(app, 'GET', '/api/openchamber/confluence/pages/search', { query: { q: 'release', limit: '99' } });
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({
        results: [expect.objectContaining({ id: '9001', title: 'Release checklist' })],
      });
      expect(request).toHaveBeenCalledWith(expect.objectContaining({
        config: { origin: 'https://confluence.example.com', token: 'CONF-secret', verifySsl: false },
      }));
    });

    it('answers unconfigured before it ever asks the instance', async () => {
      const store = await makeStore();
      const app = makeApp();
      registerConfluenceRoutes(app, { confluenceConfigStore: store });
      const res = await callRoute(app, 'GET', '/api/openchamber/confluence/pages/search', { query: { q: 'release' } });
      expect(res.statusCode).toBe(409);
      expect(res.body).toMatchObject({ kind: 'unconfigured' });
    });
  });
});
