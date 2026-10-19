import { describe, expect, it, vi } from 'vitest';

import { createMcpConsoleService } from './service.js';

const LOCAL_ENTRY = {
  name: 'local-one',
  type: 'local',
  command: ['bun', 'run', 'server.js'],
  environment: { SECRET_TOKEN: 'hush' },
  scope: 'user',
};

const REMOTE_ENTRY = {
  name: 'remote-one',
  type: 'remote',
  url: 'https://user:pass@mcp.example/rpc',
  headers: { authorization: 'Bearer hush' },
  scope: 'project',
};

const OAUTH_ENTRY = {
  name: 'oauth-one',
  type: 'remote',
  url: 'https://mcp.example/rpc',
  oauth: { server: { url: 'https://mcp.example/oauth' } },
};

const makeConnection = () => ({
  timeouts: { startup: 10, catalog: 20, execution: 30 },
  closed: false,
  close() {
    this.closed = true;
  },
});

const makeService = ({ configs = [LOCAL_ENTRY, REMOTE_ENTRY, OAUTH_ENTRY], connect } = {}) => {
  const getConfig = (name, directory) => configs.find((entry) => entry.name === name) ?? null;
  const listConfigs = () => configs;
  return createMcpConsoleService({
    getConfig,
    listConfigs,
    connect: connect ?? vi.fn().mockResolvedValue(makeConnection()),
    listConnectionTools: vi.fn().mockResolvedValue([{ name: 'echo' }]),
    callConnectionTool: vi.fn().mockResolvedValue({ isError: false, text: 'ok', contentTypes: ['text'], nonTextItems: 0, structured: null }),
  });
};

describe('config boundary', () => {
  it('answers 404 for a server the config does not name', async () => {
    const service = makeService();
    await expect(service.listTools('ghost', null)).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.callTool('ghost', 'tool', {}, null)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('refuses a remote entry whose auth is an OAuth flow', async () => {
    const service = makeService();
    await expect(service.listTools('oauth-one', null)).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.callTool('oauth-one', 'tool', {}, null)).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('connection registry', () => {
  it('adopts once and serves the catalog from cache afterwards', async () => {
    const service = makeService();
    const first = await service.listTools('local-one', null);
    expect(first.tools).toEqual([{ name: 'echo' }]);
    const second = await service.listTools('local-one', null);
    expect(second.tools).toBe(first.tools);
  });

  it('shares one in-flight handshake between concurrent callers', async () => {
    let released;
    const gate = new Promise((resolve) => {
      released = resolve;
    });
    const connect = vi.fn().mockImplementation(async () => {
      await gate;
      return makeConnection();
    });
    const service = makeService({ connect });
    const pending = Promise.all([
      service.listTools('local-one', null),
      service.listTools('local-one', null),
    ]);
    released();
    const results = await pending;
    expect(connect).toHaveBeenCalledTimes(1);
    expect(results[0].tools).toEqual(results[1].tools);
  });

  it('scopes the registry by directory: two projects, two connections', async () => {
    const connect = vi.fn().mockResolvedValue(makeConnection());
    const service = makeService({ connect });
    await service.listTools('local-one', '/work/one');
    await service.listTools('local-one', '/work/two');
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('retires a failed adoption, so the next call opens a fresh one', async () => {
    const connect = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('spawn broke'), { statusCode: 502 }))
      .mockResolvedValueOnce(makeConnection());
    const service = makeService({ connect });
    await expect(service.listTools('local-one', null)).rejects.toMatchObject({
      statusCode: 502,
      message: expect.stringContaining('"local-one" did not connect'),
    });
    await expect(service.listTools('local-one', null)).resolves.toMatchObject({ server: 'local-one' });
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('closes every held connection on closeAll', async () => {
    const connections = [makeConnection(), makeConnection()];
    let index = 0;
    const service = makeService({
      connect: vi.fn().mockImplementation(async () => connections[index++]),
    });
    await service.listTools('local-one', '/a');
    await service.listTools('remote-one', '/a');
    service.closeAll();
    expect(connections.map((connection) => connection.closed)).toEqual([true, true]);
  });
});

describe('callTool', () => {
  it('rejects a missing tool name and non-object arguments before connecting', async () => {
    const connect = vi.fn().mockResolvedValue(makeConnection());
    const service = makeService({ connect });
    await expect(service.callTool('local-one', '', {}, null)).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.callTool('local-one', 'tool', 'string-args', null)).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.callTool('local-one', 'tool', ['array'], null)).rejects.toMatchObject({ statusCode: 400 });
    expect(connect).not.toHaveBeenCalled();
  });

  it('treats absent and null arguments as empty', async () => {
    const service = makeService();
    await service.listTools('local-one', null); // the catalog caches first
    const callConnectionTool = () => service.callTool('local-one', 'echo', null, null);
    await expect(callConnectionTool()).resolves.toMatchObject({ tool: 'echo' });
  });

  it('answers 404 for a tool the cached catalog does not carry', async () => {
    const service = makeService();
    await service.listTools('local-one', null);
    await expect(service.callTool('local-one', 'ghost', {}, null)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('returns the projected tool answer with its duration', async () => {
    const service = makeService();
    const result = await service.callTool('local-one', 'echo', { a: 1 }, null);
    expect(result).toMatchObject({
      server: 'local-one',
      tool: 'echo',
      result: { isError: false, text: 'ok' },
    });
    expect(result.durationMs).toEqual(expect.any(Number));
  });
});

describe('describeServers', () => {
  it('lists every configured server without any secret riding along', async () => {
    const service = makeService();
    await service.listTools('local-one', null);
    const described = JSON.stringify(service.describeServers(null));
    expect(described).not.toContain('hush');
    expect(described).not.toContain('Bearer');
    expect(described).not.toContain('user:pass');
    const servers = service.describeServers(null);
    expect(servers.map((server) => server.name).sort()).toEqual(['local-one', 'oauth-one', 'remote-one']);
    expect(servers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'local-one',
        type: 'local',
        local: { command: ['bun', 'run', 'server.js'] },
        remote: null,
        needsAuth: false,
        console: expect.objectContaining({ connected: true, toolsKnown: 1 }),
      }),
      expect.objectContaining({
        name: 'remote-one',
        type: 'remote',
        remote: { origin: 'https://mcp.example' },
        console: expect.objectContaining({ connected: false, toolsKnown: null }),
      }),
      expect.objectContaining({ name: 'oauth-one', needsAuth: true }),
    ]));
  });
});
