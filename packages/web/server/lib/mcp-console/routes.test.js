import { describe, expect, it, vi } from 'vitest';

import { registerMcpConsoleRoutes } from './routes.js';
import { createMcpConsoleService } from './service.js';

/**
 * A route recorder in the fork's testing shape: registration may attach a
 * body-parser middleware, so the last registered handler is the one tests
 * drive, exactly like the Jira route tests do.
 */
const makeApp = () => {
  const routes = new Map();
  const record = (method) => (routePath, ...handlers) =>
    routes.set(`${method} ${routePath}`, handlers.at(-1));
  return {
    routes,
    get: record('GET'),
    post: record('POST'),
  };
};

const makeResolver = (directory = null) =>
  vi.fn().mockResolvedValue({ directory, requestedDirectory: directory, error: null });

const makeConfigService = () => {
  const describeServers = vi.fn().mockReturnValue([{ name: 'local-one', type: 'local' }]);
  const listTools = vi.fn().mockResolvedValue({
    server: 'local-one',
    tools: [{ name: 'echo', description: 'Echo' }],
  });
  const callTool = vi.fn().mockResolvedValue({
    server: 'local-one',
    tool: 'echo',
    durationMs: 5,
    result: { isError: false, text: 'ok' },
  });
  return { describeServers, listTools, callTool, closeAll: () => {} };
};

const makeReq = ({ query = {}, params = {}, body, get = () => null } = {}) => ({ query, params, body, get });

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      return res;
    },
  };
  return res;
};

const register = (app, service, resolver) =>
  registerMcpConsoleRoutes(app, {
    mcpConsoleService: service,
    resolveOptionalProjectDirectory: resolver,
  });

describe('registration guards', () => {
  it('refuses to register without a service', () => {
    expect(() => register(makeApp(), null, makeResolver())).toThrow(/mcp console routes need/);
  });

  it('refuses to register without a directory resolver', () => {
    expect(() => register(makeApp(), makeConfigService(), null)).toThrow(/mcp console routes need/);
  });
});

describe('GET /servers', () => {
  it('answers the described servers of the scoped directory', async () => {
    const app = makeApp();
    const service = makeConfigService();
    const resolver = makeResolver('/work/directory');
    register(app, service, resolver);
    const res = makeRes();
    await app.routes.get('GET /api/openchamber/mcp-console/servers')(makeReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ servers: [{ name: 'local-one', type: 'local' }] });
    expect(service.describeServers).toHaveBeenCalledWith('/work/directory');
  });

  it('turns a rejected directory into a 400, never a silent user-scope answer', async () => {
    const app = makeApp();
    const service = makeConfigService();
    const resolver = vi.fn().mockResolvedValue({ directory: null, requestedDirectory: null, error: 'unknown directory' });
    register(app, service, resolver);
    const res = makeRes();
    await app.routes.get('GET /api/openchamber/mcp-console/servers')(makeReq(), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('unknown directory');
    expect(service.describeServers).not.toHaveBeenCalled();
  });
});

describe('GET /servers/:name/tools', () => {
  it('lists the catalog for the named server', async () => {
    const app = makeApp();
    const service = makeConfigService();
    const resolver = makeResolver(null);
    register(app, service, resolver);
    const res = makeRes();
    const handler = app.routes.get('GET /api/openchamber/mcp-console/servers/:name/tools');
    await handler(makeReq({ params: { name: 'local-one' } }), res);
    expect(service.listTools).toHaveBeenCalledWith('local-one', null);
    expect(res.statusCode).toBe(200);
    expect(res.body.tools[0].name).toBe('echo');
  });

  it('propagates a service error status as-is', async () => {
    const app = makeApp();
    const service = makeConfigService();
    service.listTools.mockRejectedValue(Object.assign(new Error('no MCP server named "ghost" is configured'), { statusCode: 404 }));
    register(app, service, makeResolver(null));
    const handler = app.routes.get('GET /api/openchamber/mcp-console/servers/:name/tools');
    const res = makeRes();
    await handler(makeReq({ params: { name: 'ghost' } }), res);
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toContain('ghost');
  });
});

describe('POST /servers/:name/call', () => {
  it('passes the tool and raw arguments to the service and answers the projection', async () => {
    const app = makeApp();
    const service = makeConfigService();
    const resolver = makeResolver(null);
    register(app, service, resolver);
    const res = makeRes();
    const handler = app.routes.get('POST /api/openchamber/mcp-console/servers/:name/call');
    await handler(makeReq({ params: { name: 'local-one' }, body: { tool: 'echo', arguments: { a: 1 } } }), res);
    expect(service.callTool).toHaveBeenCalledWith('local-one', 'echo', { a: 1 }, null);
    expect(res.statusCode).toBe(200);
    expect(res.body.result.text).toBe('ok');
  });

  it('answers 400 when the body has no tool', async () => {
    const app = makeApp();
    const service = makeConfigService();
    register(app, service, makeResolver(null));
    const res = makeRes();
    const handler = app.routes.get('POST /api/openchamber/mcp-console/servers/:name/call');
    await handler(makeReq({ params: { name: 'local-one' }, body: { arguments: {} } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBeTruthy();
    expect(service.callTool).not.toHaveBeenCalled();
  });

  it('keeps diagnostics from a failed local spawn in the 502 payload', async () => {
    const app = makeApp();
    const service = makeConfigService();
    service.callTool.mockRejectedValue(Object.assign(
      new Error('"local-one" did not connect: the MCP server exited'),
      { statusCode: 502, diagnostics: 'Traceback: boom' },
    ));
    register(app, service, makeResolver(null));
    const res = makeRes();
    const handler = app.routes.get('POST /api/openchamber/mcp-console/servers/:name/call');
    await handler(makeReq({ params: { name: 'local-one' }, body: { tool: 'echo' } }), res);
    expect(res.statusCode).toBe(502);
    expect(res.body.diagnostics).toBe('Traceback: boom');
  });
});
