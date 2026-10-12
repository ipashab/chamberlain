import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerJiraRoutes } from './routes.js';
import { JiraError } from './client.js';
import { createJiraConfigStore } from './config-store.js';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const makeStore = async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-jira-routes-'));
  temporaryDirectories.push(dataDir);
  return createJiraConfigStore({ fsPromises: fs, path, dataDir });
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

const connectedStore = async () => {
  const store = await makeStore();
  await store.save({ origin: 'https://jira.example.com', token: 'JIRA-secret', verifySsl: false });
  return store;
};

const issueViewRequest = vi.fn(async () => ({
  key: 'DEMO-1',
  fields: {},
}));
const issueViewBody = () => ({
  issue: expect.objectContaining({ key: 'DEMO-1' }),
});

describe('registerJiraRoutes', () => {
  it('needs its config store', () => {
    expect(() => registerJiraRoutes(makeApp(), {})).toThrow('jira routes need a config store');
  });

  it('reads an unconfigured connection as the card first sees it', async () => {
    const store = await makeStore();
    const app = makeApp();
    registerJiraRoutes(app, { jiraConfigStore: store });
    const res = await callRoute(app, 'GET', '/api/openchamber/jira');
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ configured: false });
  });

  it('saves a connection, checks it, and never answers the token', async () => {
    const store = await makeStore();
    const app = makeApp();
    const request = vi.fn(async ({ path }) => {
      expect(path).toBe('/rest/api/2/myself');
      return { name: 'a.coder' };
    });
    registerJiraRoutes(app, { jiraConfigStore: store, createRequest: () => request });

    const res = await callRoute(app, 'PUT', '/api/openchamber/jira', {
      body: { origin: 'https://jira.example.com', token: 'JIRA-secret', verifySsl: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      configured: true,
      origin: 'https://jira.example.com',
      hasToken: true,
      verifySsl: false,
      connectionCheck: 'ok',
    });
    expect(JSON.stringify(res.body)).not.toContain('JIRA-secret');
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      config: { origin: 'https://jira.example.com', token: 'JIRA-secret', verifySsl: false },
    }));

    const reading = await callRoute(app, 'GET', '/api/openchamber/jira');
    expect(reading.body).toEqual({
      configured: true,
      origin: 'https://jira.example.com',
      hasToken: true,
      verifySsl: false,
    });
  });

  it('reports a rejected token as the save answer, kind carried from the client', async () => {
    const store = await makeStore();
    const app = makeApp();
    const request = vi.fn(async () => { throw new JiraError('unauthorized', 'the token was rejected', 401); });
    registerJiraRoutes(app, { jiraConfigStore: store, createRequest: () => request });

    const res = await callRoute(app, 'PUT', '/api/openchamber/jira', {
      body: { origin: 'https://jira.example.com', token: 'JIRA-bad' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ configured: true, connectionCheck: 'unauthorized' });
  });

  it('answers the save failures of the store with their own status', async () => {
    const store = await makeStore();
    const app = makeApp();
    registerJiraRoutes(app, { jiraConfigStore: store });

    const res = await callRoute(app, 'PUT', '/api/openchamber/jira', {
      body: { origin: 'https://jira.example.com/some/path', token: 'JIRA-secret' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('origin');
  });

  it('drops the connection on delete', async () => {
    const store = await connectedStore();
    const app = makeApp();
    registerJiraRoutes(app, { jiraConfigStore: store });
    const res = await callRoute(app, 'DELETE', '/api/openchamber/jira');
    expect(res.body).toEqual({ configured: false });
    expect(await callRoute(app, 'GET', '/api/openchamber/jira')).toMatchObject({ body: { configured: false } });
  });

  describe('issue view', () => {
    it('refuses a reference that is neither a browse URL nor an issue key', async () => {
      const store = await connectedStore();
      const app = makeApp();
      registerJiraRoutes(app, { jiraConfigStore: store });
      const res = await callRoute(app, 'GET', '/api/openchamber/jira/issues/view', {
        query: { ref: 'https://jira.example.com/projects/IDP/issues/DEMO-1' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ kind: 'bad-ref', error: expect.any(String) });
    });

    it('refuses the read without a connection', async () => {
      const store = await makeStore();
      const app = makeApp();
      registerJiraRoutes(app, { jiraConfigStore: store });
      const res = await callRoute(app, 'GET', '/api/openchamber/jira/issues/view', { query: { ref: 'DEMO-1' } });
      expect(res.statusCode).toBe(409);
      expect(res.body.kind).toBe('unconfigured');
    });

    it('refuses an issue of another instance by name, not by silent read', async () => {
      const store = await connectedStore();
      const app = makeApp();
      const request = vi.fn();
      registerJiraRoutes(app, { jiraConfigStore: store, createRequest: () => request });
      const res = await callRoute(app, 'GET', '/api/openchamber/jira/issues/view', {
        query: { ref: 'https://another.example.com/browse/DEMO-1' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.body).toEqual({ kind: 'wrong-instance', error: expect.any(String) });
      expect(request).not.toHaveBeenCalled();
    });

    it('refuses a context-path URL as another deployment behind the same host', async () => {
      const store = await connectedStore();
      const app = makeApp();
      registerJiraRoutes(app, { jiraConfigStore: store });
      const res = await callRoute(app, 'GET', '/api/openchamber/jira/issues/view', {
        query: { ref: 'https://jira.example.com/jira/browse/DEMO-1' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.body.kind).toBe('wrong-instance');
    });

    it('reads a bare key of the configured instance, token staying server-side', async () => {
      const store = await connectedStore();
      const app = makeApp();
      const request = issueViewRequest;
      registerJiraRoutes(app, { jiraConfigStore: store, createRequest: () => request });
      const res = await callRoute(app, 'GET', '/api/openchamber/jira/issues/view', { query: { ref: 'DEMO-1' } });
      expect(res.statusCode).toBe(200);
      expect(res.body.issue).toEqual(issueViewBody().issue);
      expect(request).toHaveBeenCalledWith(expect.objectContaining({
        config: { origin: 'https://jira.example.com', token: 'JIRA-secret', verifySsl: false },
      }));
      expect(JSON.stringify(res.body)).not.toContain('JIRA-secret');
    });

    it('reads a browse URL of the configured instance', async () => {
      const store = await connectedStore();
      const app = makeApp();
      registerJiraRoutes(app, { jiraConfigStore: store, createRequest: () => issueViewRequest });
      const res = await callRoute(app, 'GET', '/api/openchamber/jira/issues/view', {
        query: { ref: 'https://jira.example.com/browse/DEMO-1' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.issue).toEqual(issueViewBody().issue);
    });

    it('names the failure kinds the viewer words itself', async () => {
      const store = await connectedStore();
      const notFound = vi.fn(async () => { throw new JiraError('not-found', 'no', 404); });
      const notFoundApp = makeApp();
      registerJiraRoutes(notFoundApp, { jiraConfigStore: store, createRequest: () => notFound });
      const notFoundRes = await callRoute(notFoundApp, 'GET', '/api/openchamber/jira/issues/view', { query: { ref: 'DEMO-1' } });
      expect(notFoundRes.statusCode).toBe(404);
      expect(notFoundRes.body).toMatchObject({ kind: 'not-found' });

      const rejected = vi.fn(async () => { throw new JiraError('unauthorized', 'no', 401); });
      const rejectedApp = makeApp();
      registerJiraRoutes(rejectedApp, { jiraConfigStore: store, createRequest: () => rejected });
      const rejectedRes = await callRoute(rejectedApp, 'GET', '/api/openchamber/jira/issues/view', { query: { ref: 'DEMO-1' } });
      expect(rejectedRes.statusCode).toBe(502);
      expect(rejectedRes.body.kind).toBe('unauthorized');

      const dead = vi.fn(async () => { throw new JiraError('unreachable', 'no', null); });
      const deadApp = makeApp();
      registerJiraRoutes(deadApp, { jiraConfigStore: store, createRequest: () => dead });
      const deadRes = await callRoute(deadApp, 'GET', '/api/openchamber/jira/issues/view', { query: { ref: 'DEMO-1' } });
      expect(deadRes.body).toMatchObject({ kind: 'unreachable' });
    });
  });

  describe('issue search', () => {
    it('refuses to search without a connection', async () => {
      const store = await makeStore();
      const app = makeApp();
      registerJiraRoutes(app, { jiraConfigStore: store });
      const res = await callRoute(app, 'GET', '/api/openchamber/jira/issues/search', { query: { q: 'allure' } });
      expect(res.statusCode).toBe(409);
      expect(res.body.kind).toBe('unconfigured');
    });

    it('answers the sanitized rows for the panel input', async () => {
      const store = await connectedStore();
      const app = makeApp();
      const request = vi.fn(async () => ({
        issues: [{ key: 'DEMO-100', fields: { summary: 'allure', updated: '2026-10-12T10:00:00.000+0300', status: { name: 'В работе' }, issuetype: { name: 'История' } } }],
      }));
      registerJiraRoutes(app, { jiraConfigStore: store, createRequest: () => request });
      const res = await callRoute(app, 'GET', '/api/openchamber/jira/issues/search', {
        query: { q: 'all"ure', limit: '3' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.issues).toEqual([
        {
          key: 'DEMO-100',
          url: 'https://jira.example.com/browse/DEMO-100',
          summary: 'allure',
          updated: '2026-10-12T10:00:00.000+0300',
          statusName: 'В работе',
          typeName: 'История',
        },
      ]);
      expect(decodeURIComponent(request.mock.calls[0][0].search)).toContain('text ~ "allure*"');
      expect(request.mock.calls[0][0].search).toContain('maxResults=3');
    });

    it('answers an unreachable kind when the instance does not answer', async () => {
      const store = await connectedStore();
      const app = makeApp();
      const request = vi.fn(async () => { throw new JiraError('unreachable', 'no', null); });
      registerJiraRoutes(app, { jiraConfigStore: store, createRequest: () => request });
      const res = await callRoute(app, 'GET', '/api/openchamber/jira/issues/search', { query: { q: 'allure' } });
      expect(res.statusCode).toBe(502);
      expect(res.body.kind).toBe('unreachable');
    });
  });

  describe('avatar proxy', () => {
    it('refuses a path outside the instance image allowlist before any fetch', async () => {
      const store = await connectedStore();
      const app = makeApp();
      const request = vi.fn();
      registerJiraRoutes(app, { jiraConfigStore: store, createAvatarRequest: () => request });
      const res = await callRoute(app, 'GET', '/api/openchamber/jira/avatar', {
        query: { path: 'https://evil.example.com/secure/useravatar' },
      });
      expect(res.statusCode).toBe(400);
      const resTwo = await callRoute(app, 'GET', '/api/openchamber/jira/avatar', {
        query: { path: '/rest/api/2/myself' },
      });
      expect(resTwo.statusCode).toBe(400);
      expect(request).not.toHaveBeenCalled();
    });

    it('proxies the instance image bytes with the stored token', async () => {
      const store = await connectedStore();
      const app = makeApp();
      const request = vi.fn(async () => ({ contentType: 'image/png', bytes: Buffer.from('png-bytes') }));
      registerJiraRoutes(app, { jiraConfigStore: store, createAvatarRequest: () => request });
      const res = await callRoute(app, 'GET', '/api/openchamber/jira/avatar', {
        query: { path: '/secure/useravatar?ownerId=a.coder' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers).toMatchObject({ 'content-type': 'image/png', 'cache-control': 'private, max-age=86400' });
      expect(Buffer.isBuffer(res.body)).toBe(true);
      expect(request).toHaveBeenCalledWith(expect.objectContaining({
        config: { origin: 'https://jira.example.com', token: 'JIRA-secret', verifySsl: false },
        path: '/secure/useravatar?ownerId=a.coder',
      }));
    });

    it('answers an absent image with the status the drawing side falls back on', async () => {
      const store = await connectedStore();
      const app = makeApp();
      const request = vi.fn(async () => { throw new JiraError('not-found', 'no', 404); });
      registerJiraRoutes(app, { jiraConfigStore: store, createAvatarRequest: () => request });
      const res = await callRoute(app, 'GET', '/api/openchamber/jira/avatar', { query: { path: '/images/x.svg' } });
      expect(res.statusCode).toBe(404);
    });
  });
});
