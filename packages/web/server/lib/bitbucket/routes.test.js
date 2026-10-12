import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerBitbucketRoutes } from './routes.js';
import { BitbucketError } from './client.js';
import { createBitbucketConfigStore } from './config-store.js';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const makeStore = async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-bitbucket-routes-'));
  temporaryDirectories.push(dataDir);
  return createBitbucketConfigStore({ fsPromises: fs, path, dataDir });
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

describe('registerBitbucketRoutes', () => {
  it('needs its config store', () => {
    expect(() => registerBitbucketRoutes(makeApp(), {})).toThrow('bitbucket routes need a config store');
  });

  it('reads an unconfigured connection as the card first sees it', async () => {
    const store = await makeStore();
    const app = makeApp();
    registerBitbucketRoutes(app, { bitbucketConfigStore: store });
    const res = await callRoute(app, 'GET', '/api/openchamber/bitbucket');
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ configured: false });
  });

  it('saves a connection, checks it, and never answers the token', async () => {
    const store = await makeStore();
    const app = makeApp();
    const request = vi.fn(async ({ path }) => {
      expect(path).toBe('/rest/api/1.0/projects?limit=1');
      return { values: [] };
    });
    registerBitbucketRoutes(app, { bitbucketConfigStore: store, createRequest: () => request });

    const res = await callRoute(app, 'PUT', '/api/openchamber/bitbucket', {
      body: { origin: 'https://bitbucket.example.com', token: 'BBDC-secret', verifySsl: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      configured: true,
      origin: 'https://bitbucket.example.com',
      hasToken: true,
      verifySsl: false,
      connectionCheck: 'ok',
    });
    expect(JSON.stringify(res.body)).not.toContain('BBDC-secret');
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      config: { origin: 'https://bitbucket.example.com', token: 'BBDC-secret', verifySsl: false },
    }));

    const reading = await callRoute(app, 'GET', '/api/openchamber/bitbucket');
    expect(reading.body).toEqual({
      configured: true,
      origin: 'https://bitbucket.example.com',
      hasToken: true,
      verifySsl: false,
    });
  });

  it('reports a rejected token as the save answer, kind carried from the client', async () => {
    const store = await makeStore();
    const app = makeApp();
    const request = vi.fn(async () => {
      throw Object.assign(new Error('401'), { kind: 'unauthorized' });
    });
    registerBitbucketRoutes(app, { bitbucketConfigStore: store, createRequest: () => request });
    const res = await callRoute(app, 'PUT', '/api/openchamber/bitbucket', {
      body: { origin: 'https://bitbucket.example.com', token: 'BBDC-bad' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.connectionCheck).toBe('unauthorized');
  });

  it('answers an invalid save with the store error and a 400', async () => {
    const store = await makeStore();
    const app = makeApp();
    registerBitbucketRoutes(app, { bitbucketConfigStore: store, createRequest: () => async () => ({}) });
    const res = await callRoute(app, 'PUT', '/api/openchamber/bitbucket', {
      body: { origin: 'https://bitbucket.example.com/projects/OC' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/origin/);
  });

  it('skips the connection check when there is no token to authenticate', async () => {
    const store = await makeStore();
    const app = makeApp();
    const request = vi.fn(async () => ({ values: [] }));
    registerBitbucketRoutes(app, { bitbucketConfigStore: store, createRequest: () => request });
    // An origin alone does not make a connection: the token rule holds it
    // back until a real credential arrives, and no check can run.
    const res = await callRoute(app, 'PUT', '/api/openchamber/bitbucket', {
      body: { origin: 'https://bitbucket.example.com' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.configured).toBe(false);
    expect(res.body.connectionCheck).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it('disconnects outright', async () => {
    const store = await makeStore();
    await store.save({ origin: 'https://bitbucket.example.com', token: 'BBDC-one' });
    const app = makeApp();
    registerBitbucketRoutes(app, { bitbucketConfigStore: store });
    const res = await callRoute(app, 'DELETE', '/api/openchamber/bitbucket');
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ configured: false });
    expect(await callRoute(app, 'GET', '/api/openchamber/bitbucket')).toMatchObject({ body: { configured: false } });
  });
});

describe('the pull view route', () => {
  const VIEW_ROUTE = '/api/openchamber/bitbucket/pulls/view';

  const makeConfigured = async () => {
    const store = await makeStore();
    await store.save({ origin: 'https://bitbucket.example.com', token: 'BBDC-live' });
    return store;
  };

  /** A request seam answering one pull's whole REST surface. */
  const makePullRequest = () => async ({ path }) => {
    if (path.endsWith('/pull-requests/110')) {
      return {
        title: 'Remove the temporary exception',
        state: 'MERGED',
        author: { displayName: 'Sv Gorbunov' },
        fromRef: { displayId: 'fix', latestCommit: 'abc123' },
        toRef: { displayId: 'master' },
        reviewers: [],
      };
    }
    if (path.endsWith('/diff')) return { truncated: false, diffs: [] };
    if (path.startsWith('/rest/build-status/1.0/commits/')) return { values: [] };
    if (path.endsWith('/commits')) {
      return {
        isLastPage: true,
        values: [{ id: 'abc123def456', displayId: 'abc123d', author: { name: 'Sv Gorbunov' }, authorTimestamp: 1789660000, message: 'Remove the temporary exception' }],
      };
    }
    if (path.endsWith('/activities')) return { isLastPage: true, values: [] };
    throw new Error(`unexpected path ${path}`);
  };

  it('refuses a link that is not a Bitbucket pull request', async () => {
    const store = await makeConfigured();
    const app = makeApp();
    registerBitbucketRoutes(app, { bitbucketConfigStore: store, createRequest: makePullRequest });
    const res = await callRoute(app, 'GET', VIEW_ROUTE, { query: { url: 'https://github.com/octocat/hello/pull/1' } });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ kind: 'bad-url', error: expect.any(String) });
  });

  it('answers unconfigured with 409, before any request could be made', async () => {
    const store = await makeStore();
    const app = makeApp();
    const request = vi.fn();
    registerBitbucketRoutes(app, { bitbucketConfigStore: store, createRequest: request });
    const res = await callRoute(app, 'GET', VIEW_ROUTE, { query: { url: 'https://bitbucket.example.com/projects/AUTO/repos/ai-reviewer/pull-requests/110' } });
    expect(res.statusCode).toBe(409);
    expect(res.body.kind).toBe('unconfigured');
    expect(request).not.toHaveBeenCalled();
  });

  it('refuses a pull of another instance: never a stranger\'s read', async () => {
    const store = await makeConfigured();
    const app = makeApp();
    const request = vi.fn();
    registerBitbucketRoutes(app, { bitbucketConfigStore: store, createRequest: request });

    const otherOrigin = await callRoute(app, 'GET', VIEW_ROUTE, {
      query: { url: 'https://elsewhere.example.com/projects/AUTO/repos/ai-reviewer/pull-requests/110' },
    });
    expect(otherOrigin.statusCode).toBe(409);
    expect(otherOrigin.body.kind).toBe('wrong-instance');

    // One host with a context path is another deployment behind the same
    // host: the configured connection is always an instance root.
    const withContext = await callRoute(app, 'GET', VIEW_ROUTE, {
      query: { url: 'https://bitbucket.example.com/dc/projects/AUTO/repos/ai-reviewer/pull-requests/110' },
    });
    expect(withContext.statusCode).toBe(409);
    expect(withContext.body.kind).toBe('wrong-instance');
    expect(request).not.toHaveBeenCalled();
  });

  it('answers the whole view of the configured instance\'s pull', async () => {
    const store = await makeConfigured();
    const app = makeApp();
    const request = makePullRequest();
    registerBitbucketRoutes(app, { bitbucketConfigStore: store, createRequest: () => request });
    const res = await callRoute(app, 'GET', VIEW_ROUTE, {
      query: { url: 'https://bitbucket.example.com/projects/AUTO/repos/ai-reviewer/pull-requests/110' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.pull).toMatchObject({ number: 110, state: 'merged', author: 'Sv Gorbunov' });
    expect(res.body.commits).toEqual([
      { sha: 'abc123def456', shortSha: 'abc123d', author: 'Sv Gorbunov', summary: 'Remove the temporary exception', date: 1789660000000 },
    ]);
    expect(res.body.files).toEqual([]);
    expect(res.body.comments).toEqual([]);
    // The connection answers for the read; nothing about it travels back.
    expect(JSON.stringify(res.body)).not.toContain('BBDC-live');
  });

  it('carries an unexpected failure into a plain 500 answer', async () => {
    const store = await makeConfigured();
    const app = makeApp();
    registerBitbucketRoutes(app, { bitbucketConfigStore: store, createRequest: () => async () => {
      throw new Error('boom');
    } });
    const res = await callRoute(app, 'GET', VIEW_ROUTE, {
      query: { url: 'https://bitbucket.example.com/projects/AUTO/repos/ai-reviewer/pull-requests/110' },
    });
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('Failed to read the pull request.');
  });

  it('answers a rejected token with 502 and the kind', async () => {
    const store = await makeConfigured();
    const app = makeApp();
    registerBitbucketRoutes(app, { bitbucketConfigStore: store, createRequest: () => async () => {
      throw new BitbucketError('unauthorized', 'the access token was rejected', 401);
    } });
    const res = await callRoute(app, 'GET', VIEW_ROUTE, {
      query: { url: 'https://bitbucket.example.com/projects/AUTO/repos/ai-reviewer/pull-requests/110' },
    });
    expect(res.statusCode).toBe(502);
    expect(res.body.kind).toBe('unauthorized');
  });

  it('answers a missing pull with 404 and the kind', async () => {
    const store = await makeConfigured();
    const app = makeApp();
    registerBitbucketRoutes(app, { bitbucketConfigStore: store, createRequest: () => async () => {
      throw new BitbucketError('not-found', 'the pull request was not found', 404);
    } });
    const res = await callRoute(app, 'GET', VIEW_ROUTE, {
      query: { url: 'https://bitbucket.example.com/projects/AUTO/repos/ai-reviewer/pull-requests/999' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.body.kind).toBe('not-found');
  });

  it('answers an unreachable instance with 502 and the kind', async () => {
    const store = await makeConfigured();
    const app = makeApp();
    registerBitbucketRoutes(app, { bitbucketConfigStore: store, createRequest: () => async () => {
      throw new BitbucketError('unreachable', 'the instance did not answer', null);
    } });
    const res = await callRoute(app, 'GET', VIEW_ROUTE, {
      query: { url: 'https://bitbucket.example.com/projects/AUTO/repos/ai-reviewer/pull-requests/110' },
    });
    expect(res.statusCode).toBe(502);
    expect(res.body.kind).toBe('unreachable');
  });
});

describe('the open pulls route', () => {
  const LIST_ROUTE = '/api/openchamber/bitbucket/pulls';

  const makeConfigured = async () => {
    const store = await makeStore();
    await store.save({ origin: 'https://bitbucket.example.com', token: 'BBDC-live' });
    return store;
  };

  /** A dashboard page seam: open and closed pulls mixed, paged. */
  const makeDashboard = (pages) => {
    const remaining = [...pages];
    return async ({ path }) => {
      expect(path).toBe('/rest/api/1.0/dashboard/pull-requests');
      return remaining.shift();
    };
  };

  const openPull = (id, title, updatedDate) => ({
    id,
    title,
    state: 'OPEN',
    open: true,
    createdDate: updatedDate - 1000,
    updatedDate,
    author: { user: { displayName: 'Alex Coder', name: 'acoder', slug: 'acoder' } },
    fromRef: { repository: { slug: 'demo-service', project: { key: 'DEMO' } } },
  });

  it('answers the open pulls of the token\'s dashboard', async () => {
    const store = await makeConfigured();
    const app = makeApp();
    const dashboard = makeDashboard([
      {
        isLastPage: true,
        values: [
          openPull(4244, 'Add tracing headers', 1789669800000),
          { id: 8500, title: 'Merged long ago', state: 'MERGED', open: false, author: {}, fromRef: {} },
        ],
      },
    ]);
    registerBitbucketRoutes(app, { bitbucketConfigStore: store, createRequest: () => dashboard });
    const res = await callRoute(app, 'GET', LIST_ROUTE, { query: {} });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      pulls: [
        {
          number: 4244,
          url: 'https://bitbucket.example.com/projects/DEMO/repos/demo-service/pull-requests/4244',
          title: 'Add tracing headers',
          state: 'open',
          author: 'Alex Coder',
          authorSlug: 'acoder',
          repo: { project: 'DEMO', slug: 'demo-service' },
          createdAt: 1789669799000,
          updatedAt: 1789669800000,
        },
      ],
      truncated: false,
    });
  });

  it('clamps the limit and walks the pages until the cap is met', async () => {
    const store = await makeConfigured();
    const app = makeApp();
    const fullPage = (from) => ({
      isLastPage: from >= 100 ? undefined : false,
      values: Array.from({ length: 3 }, (_, index) => openPull(from + index, `Pull ${from + index}`, from + index)),
    });
    let start = 0;
    const dashboard = async () => {
      const page = fullPage(start);
      start += 3;
      return page;
    };
    registerBitbucketRoutes(app, { bitbucketConfigStore: store, createRequest: () => dashboard });
    const res = await callRoute(app, 'GET', LIST_ROUTE, { query: { limit: ['5'] } });
    expect(res.statusCode).toBe(200);
    expect(res.body.pulls).toHaveLength(5);
    expect(res.body.truncated).toBe(true);
  });

  it('reads a limit the parser could not make a number of as the default', async () => {
    const store = await makeConfigured();
    const app = makeApp();
    const dashboard = makeDashboard([{ isLastPage: true, values: [openPull(1, 'One', 1)] }]);
    registerBitbucketRoutes(app, { bitbucketConfigStore: store, createRequest: () => dashboard });
    const res = await callRoute(app, 'GET', LIST_ROUTE, { query: { limit: 'not-a-number' } });
    expect(res.statusCode).toBe(200);
    expect(res.body.pulls).toHaveLength(1);
  });

  it('answers unconfigured with 409, before any request could be made', async () => {
    const store = await makeStore();
    const app = makeApp();
    const request = vi.fn();
    registerBitbucketRoutes(app, { bitbucketConfigStore: store, createRequest: request });
    const res = await callRoute(app, 'GET', LIST_ROUTE, { query: {} });
    expect(res.statusCode).toBe(409);
    expect(res.body.kind).toBe('unconfigured');
    expect(request).not.toHaveBeenCalled();
  });

  it('answers a rejected token with 502 and the kind', async () => {
    const store = await makeConfigured();
    const app = makeApp();
    registerBitbucketRoutes(app, { bitbucketConfigStore: store, createRequest: () => async () => {
      throw new BitbucketError('unauthorized', 'the access token was rejected', 401);
    } });
    const res = await callRoute(app, 'GET', LIST_ROUTE, { query: {} });
    expect(res.statusCode).toBe(502);
    expect(res.body.kind).toBe('unauthorized');
  });
});

describe('the avatar proxy route', () => {
  const AVATAR_ROUTE = '/api/openchamber/bitbucket/pulls/avatar';

  const makeConfigured = async () => {
    const store = await makeStore();
    await store.save({ origin: 'https://bitbucket.example.com', token: 'BBDC-live' });
    return store;
  };

  it('streams one user\'s avatar bytes, fetched with the stored token', async () => {
    const store = await makeConfigured();
    const app = makeApp();
    const calls = [];
    const avatarRequest = async ({ config, path, search }) => {
      calls.push({ path, search, token: config.token });
      return { contentType: 'image/png', bytes: Buffer.from('png-bytes') };
    };
    registerBitbucketRoutes(app, { bitbucketConfigStore: store, createAvatarRequest: () => avatarRequest });
    const res = await callRoute(app, 'GET', AVATAR_ROUTE, { query: { slug: 'acoder' } });
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual([
      { path: '/users/acoder/avatar.png', search: '?s=48', token: 'BBDC-live' },
    ]);
    expect(res.body.toString()).toBe('png-bytes');
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toContain('max-age');
  });

  it('honors the only sizes the drawing side knows', async () => {
    const store = await makeConfigured();
    const app = makeApp();
    let asked = '';
    registerBitbucketRoutes(app, {
      bitbucketConfigStore: store,
      createAvatarRequest: () => async ({ search }) => {
        asked = search;
        return { contentType: 'image/png', bytes: Buffer.from('x') };
      },
    });
    const res = await callRoute(app, 'GET', AVATAR_ROUTE, { query: { slug: 'acoder', size: '64' } });
    expect(res.statusCode).toBe(200);
    expect(asked).toBe('?s=64');
    // Any other size reads back as the default, not an error.
    await callRoute(app, 'GET', AVATAR_ROUTE, { query: { slug: 'acoder', size: '999' } });
    expect(asked).toBe('?s=48');
  });

  it('refuses a slug that could forge a path', async () => {
    const store = await makeConfigured();
    const app = makeApp();
    const avatarRequest = vi.fn();
    registerBitbucketRoutes(app, { bitbucketConfigStore: store, createAvatarRequest: () => avatarRequest });
    const res = await callRoute(app, 'GET', AVATAR_ROUTE, { query: { slug: '../rest/api' } });
    expect(res.statusCode).toBe(400);
    expect(avatarRequest).not.toHaveBeenCalled();
  });

  it('answers unconfigured with 409, before any request could be made', async () => {
    const store = await makeStore();
    const app = makeApp();
    const avatarRequest = vi.fn();
    registerBitbucketRoutes(app, { bitbucketConfigStore: store, createAvatarRequest: () => avatarRequest });
    const res = await callRoute(app, 'GET', AVATAR_ROUTE, { query: { slug: 'acoder' } });
    expect(res.statusCode).toBe(409);
    expect(avatarRequest).not.toHaveBeenCalled();
  });

  it('answers a missing avatar with 404 and no body, the reader\'s fallback signal', async () => {
    const store = await makeConfigured();
    const app = makeApp();
    registerBitbucketRoutes(app, {
      bitbucketConfigStore: store,
      createAvatarRequest: () => async () => {
        throw new BitbucketError('not-found', 'the avatar was not found', 404);
      },
    });
    const res = await callRoute(app, 'GET', AVATAR_ROUTE, { query: { slug: 'ghost.user' } });
    expect(res.statusCode).toBe(404);
    expect(res.body).toBeUndefined();
  });

  it('answers an unreachable or rejected instance with 502', async () => {
    const store = await makeConfigured();
    const app = makeApp();
    registerBitbucketRoutes(app, {
      bitbucketConfigStore: store,
      createAvatarRequest: () => async () => {
        throw new BitbucketError('unauthorized', 'the access token was rejected', 401);
      },
    });
    const res = await callRoute(app, 'GET', AVATAR_ROUTE, { query: { slug: 'acoder' } });
    expect(res.statusCode).toBe(502);
  });
});
