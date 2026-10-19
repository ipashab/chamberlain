import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { McpConsoleError, callConnectionTool, connectMcpServer, listConnectionTools } from './client.js';

/**
 * A child process stand-in with the surface StdioConnection touches: line
 * writes on stdin, readable stdio and err, an exit event, kill bookkeeping.
 * `onRequest` sees every line the client writes and can answer on stdout.
 */
const makeFakeChild = (onRequest = () => {}) => {
  const child = new EventEmitter();
  child.writtenLines = [];
  const collect = (line) => {
    child.writtenLines.push(JSON.parse(line));
    onRequest(JSON.parse(line), child);
  };
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      collect(chunk.toString().replace(/\n$/, ''));
      callback();
    },
  });
  child.stdin.end = () => {};
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.killed = false;
  child.killCalls = [];
  child.kill = (signal) => {
    child.killed = true;
    child.killCalls.push(signal);
  };
  child.answer = (id, payload) => {
    child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...payload })}\n`);
  };
  return child;
};

// A server script for the common happy path: initialize, then tools/list
// with one cursor page, then tools/call.
const scriptStandardHandshake = (request, child) => {
  if (request.method === 'initialize') {
    child.answer(request.id, {
      result: { protocolVersion: '2025-06-18', serverInfo: { name: 'fake' }, capabilities: {} },
    });
  } else if (request.method === 'tools/list' && !request.params.cursor) {
    child.answer(request.id, {
      result: { tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }, {}], nextCursor: 'p2' },
    });
  } else if (request.method === 'tools/list' && request.params.cursor === 'p2') {
    child.answer(request.id, { result: { tools: [{ name: 'ping' }] } });
  } else if (request.method === 'tools/call') {
    child.answer(request.id, {
      result: {
        content: [
          { type: 'text', text: 'first' },
          { type: 'image', data: 'x' },
          { type: 'text', text: 'second' },
        ],
        structuredContent: { answer: 42 },
      },
    });
  }
};

const spawnWith = (child) => () => child;
const connectLocal = (child, config = {}) =>
  connectMcpServer(
    { type: 'local', command: ['fake-server'], ...config },
    { spawn: spawnWith(child) },
  );

describe('connectMcpServer: local stdio', () => {
  it('runs the handshake and forwards the initialized notification', async () => {
    const child = makeFakeChild(scriptStandardHandshake);
    const connection = await connectLocal(child);
    expect(child.writtenLines[0].method).toBe('initialize');
    expect(child.writtenLines[0].params.protocolVersion).toBe('2025-06-18');
    expect(child.writtenLines[0].params.clientInfo.name).toBe('openchamber');
    expect(child.writtenLines[1]).toEqual({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    expect(connection.serverInfo).toEqual({ name: 'fake' });
    connection.close();
    expect(child.killCalls).toContain('SIGTERM');
  });

  it('keeps a missing command a caller error, not a spawn attempt', async () => {
    await expect(connectLocal(makeFakeChild(), { command: [] })).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('a dying process turns a hanging handshake into a transport failure', async () => {
    const child = makeFakeChild(() => {});
    const pending = connectLocal(child, { timeout: { startup: 10_000 } });
    child.exitCode = 1;
    child.emit('exit');
    await expect(pending).rejects.toMatchObject({ statusCode: 502 });
    // SIGTERM first, SIGKILL never fired: the process already went.
    expect(child.killCalls).toEqual([]);
  });

  it('walls off a silent spawn with the startup timeout', async () => {
    const child = makeFakeChild(() => {});
    await expect(connectLocal(child, { timeout: { startup: 30 } })).rejects.toMatchObject({
      statusCode: 504,
    });
    expect(child.killCalls).toContain('SIGTERM');
  });

  it('carries the stderr tail as diagnostics when the handshake fails', async () => {
    const child = makeFakeChild((request, fake) => {
      if (request.method === 'initialize') {
        child.stderr.write('Traceback (most recent call last):\nboom\n');
        child.exitCode = 1;
        child.emit('exit');
      }
    });
    await expect(connectLocal(child)).rejects.toMatchObject({
      statusCode: 502,
      diagnostics: expect.stringContaining('boom'),
    });
  });

  it('spawns with the configured cwd and environment layered over ours', async () => {
    let spawnOptions;
    const child = makeFakeChild(scriptStandardHandshake);
    const connection = await connectMcpServer(
      { type: 'local', command: ['fake-server'], cwd: '/tmp/work', environment: { TOKEN: 'x' } },
      {
        spawn: (_command, _args, options) => {
          spawnOptions = options;
          return child;
        },
      },
    );
    expect(spawnOptions.cwd).toBe('/tmp/work');
    expect(spawnOptions.env).toMatchObject({ TOKEN: 'x' });
    expect(z.string().safeParse(spawnOptions.env.PATH).success).toBe(true);
    connection.close();
  });
});

describe('listConnectionTools', () => {
  it('walks cursor pages to the end and sanitizes entries', async () => {
    const child = makeFakeChild(scriptStandardHandshake);
    const connection = await connectLocal(child);
    const tools = await listConnectionTools(connection, connection.timeouts.catalog);
    expect(tools).toEqual([
      { name: 'echo', description: 'Echo', inputSchema: { type: 'object' } },
      { name: '', description: '', inputSchema: null }, // junk entry kept in shape, not fatal
      { name: 'ping', description: '', inputSchema: null },
    ]);
    connection.close();
  });
});

describe('callConnectionTool', () => {
  it('projects content into text plus non-text counts plus structured output', async () => {
    const child = makeFakeChild(scriptStandardHandshake);
    const connection = await connectLocal(child);
    const result = await callConnectionTool(connection, 'echo', { a: 1 }, connection.timeouts.execution);
    expect(result).toEqual({
      isError: false,
      text: 'first\nsecond',
      contentTypes: ['text', 'image'],
      nonTextItems: 1,
      structured: { answer: 42 },
    });
    connection.close();
  });

  it('maps a json-rpc method-not-found to a 404 the panel can show', async () => {
    const child = makeFakeChild((request, fake) => {
      if (request.method === 'initialize') fake.answer(request.id, { result: {} });
      else fake.answer(request.id, { error: { code: -32601, message: 'no such tool' } });
    });
    const connection = await connectLocal(child);
    await expect(callConnectionTool(connection, 'ghost', {}, 1_000)).rejects.toMatchObject({
      statusCode: 404,
      message: expect.stringContaining('no such tool'),
    });
    connection.close();
  });
});

/**
 * A fetch stand-in answering POSTs from a queue of scripted responses; the
 * recorded requests let a test assert headers and bodies.
 */
const makeFetchScript = (script) => {
  const recorded = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    recorded.push({ url, options, body });
    const respond = script[body.method] ?? (() => ({ status: 404, headers: new Map(), json: {} }));
    const response = respond(body);
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      headers: {
        get: (name) => response.headers.get(name) ?? null,
      },
      json: async () => response.json,
      body: response.body ?? null,
    };
  };
  return { fetchImpl, recorded };
};

const sseBodyFrom = (message) => ({
  getReader: () => {
    const chunks = [`data: ${JSON.stringify(message)}\n\n`];
    return {
      read: async () => (chunks.length > 0
        ? { done: false, value: chunks.shift() }
        : { done: true }),
      cancel: async () => {},
    };
  },
});

const REMOTE_CONFIG = { type: 'remote', url: 'https://mcp.example/rpc', headers: { authorization: 'Bearer t' } };

const remoteScriptBasic = {
  initialize: () => ({
    status: 200,
    headers: new Map([['mcp-session-id', 'sess-1'], ['content-type', 'application/json']]),
    json: { jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'remote' } } },
  }),
  'tools/list': () => ({
    status: 200,
    headers: new Map([['content-type', 'application/json']]),
    json: { jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'one' }] } },
  }),
  'tools/call': (body) => ({
    status: 200,
    headers: new Map([['content-type', 'text/event-stream']]),
    body: sseBodyFrom({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'via sse' }] } }),
  }),
};

describe('connectMcpServer: remote streamable http', () => {
  it('captures the session id and reuses it on later requests', async () => {
    const { fetchImpl, recorded } = makeFetchScript(remoteScriptBasic);
    const connection = await connectMcpServer(REMOTE_CONFIG, { fetch: fetchImpl });
    const tools = await listConnectionTools(connection, connection.timeouts.catalog);
    expect(tools.map((tool) => tool.name)).toEqual(['one']);
    expect(recorded[0].options.headers['mcp-session-id']).toBeUndefined();
    expect(recorded[1].options.headers['mcp-session-id']).toBe('sess-1');
    expect(recorded[1].options.headers.authorization).toBe('Bearer t');
    connection.close();
  });

  it('reads a tools/call answer from an SSE stream', async () => {
    const { fetchImpl } = makeFetchScript(remoteScriptBasic);
    const connection = await connectMcpServer(REMOTE_CONFIG, { fetch: fetchImpl });
    const result = await callConnectionTool(connection, 'one', {}, connection.timeouts.execution);
    expect(result.text).toBe('via sse');
    connection.close();
  });

  it('answers a server-side http failure with a 502', async () => {
    const { fetchImpl } = makeFetchScript({
      initialize: () => ({ status: 500, headers: new Map(), json: {} }),
    });
    await expect(connectMcpServer(REMOTE_CONFIG, { fetch: fetchImpl })).rejects.toMatchObject({
      statusCode: 502,
    });
  });

  it('refuses a legacy SSE remote before any request goes out', async () => {
    const { fetchImpl, recorded } = makeFetchScript(remoteScriptBasic);
    await expect(connectMcpServer(
      { ...REMOTE_CONFIG, protocol: 'legacy' },
      { fetch: fetchImpl },
    )).rejects.toMatchObject({ statusCode: 400 });
    expect(recorded).toEqual([]);
  });

  it('refuses an entry without transport inputs', async () => {
    await expect(connectMcpServer({ type: 'remote', url: '' }, { fetch: async () => {} })).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(connectMcpServer({ type: 'strange' }, {})).rejects.toMatchObject({ statusCode: 400 });
    await expect(connectMcpServer({ type: 'local', command: [] }, {})).rejects.toMatchObject({ statusCode: 400 });
  });

  it('answers a failed spawn immediately, without waiting for the timeout', async () => {
    const child = makeFakeChild(() => {});
    const connection = connectMcpServer({ type: 'local', command: ['missing-binary'] }, { spawn: spawnWith(child) });
    // A spawn failure never writes to stdin and may never fire `exit`.
    child.emit('error', Object.assign(new Error('spawn missing-binary ENOENT'), { code: 'ENOENT' }));
    await expect(connection).rejects.toMatchObject({
      statusCode: 502,
      message: expect.stringContaining('missing-binary'),
      diagnostics: expect.stringContaining('ENOENT'),
    });
    expect(child.killCalls).toEqual([]);
  });
});
