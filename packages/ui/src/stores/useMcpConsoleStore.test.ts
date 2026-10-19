import { beforeEach, describe, expect, mock, test } from 'bun:test';

import type { McpConsoleServer, McpConsoleTool, McpConsoleToolCall } from '@/lib/mcp-console/mcp-console-api';
type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: Error) => void };
const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

// The panel's data path is the API client; the store test drives the same
// promises the client would, without touching the network. Each case arms a
// fresh deferred, so answers from one case cannot leak into the next.
let serversDeferred: Deferred<McpConsoleServer[]>;
let toolsDeferred: Deferred<McpConsoleTool[]>;
let callDeferred: Deferred<McpConsoleToolCall>;
// The catalog walk asks every server, so its test routes tool answers by name.
let toolsByName: Map<string, Deferred<McpConsoleTool[]>>;

mock.module('@/lib/mcp-console/mcp-console-api', () => ({
  mcpConsoleApi: {
    servers: () => serversDeferred.promise,
    tools: (server: string) => toolsByName.get(server)?.promise ?? toolsDeferred.promise,
    call: () => callDeferred.promise,
  },
}));

const { useMcpConsoleStore, callConsoleTool } = await import('./useMcpConsoleStore');

const sampleTool: McpConsoleTool = { name: 'echo', description: 'Echo', inputSchema: null };
const sampleCall: McpConsoleToolCall = {
  server: 'supl',
  tool: 'echo',
  durationMs: 12,
  result: { isError: false, text: 'ok', contentTypes: ['text'], nonTextItems: 0, structured: null },
};
const serverRow = (name: string): McpConsoleServer => ({
  name,
  type: 'local',
  scope: 'user',
  disabled: false,
  codemode: false,
  local: { command: ['run', name] },
  remote: null,
  needsAuth: false,
  console: { connected: false, toolsKnown: null },
});

// A rejection through a .then().catch() chain schedules one microtask more
// than a plain resolution; a macrotask boundary covers both and any longer
// chained walk.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const resetState = () =>
  useMcpConsoleStore.setState({
    frame: 'servers',
    directory: null,
    directoryIsCurrent: true,
    server: null,
    tool: null,
    runReturn: 'tools',
    tools: [],
    toolsLoading: false,
    toolsError: null,
    catalogLoading: false,
    catalogError: null,
    catalogEntries: [],
    isCalling: false,
    lastCall: null,
    callError: null,
  });

describe('MCP console store', () => {
  beforeEach(() => {
    serversDeferred = deferred();
    toolsDeferred = deferred();
    callDeferred = deferred();
    toolsByName = new Map();
    resetState();
  });

  test('opening without a server starts at the server list', () => {
    useMcpConsoleStore.getState().open();
    const state = useMcpConsoleStore.getState();
    expect(state.frame).toBe('servers');
    expect(state.server).toBeNull();
    expect(state.directoryIsCurrent).toBe(true);
  });

  test('opening on a server asks for its catalog right away', () => {
    useMcpConsoleStore.getState().open({ server: 'supl', directory: '/work/one' });
    const state = useMcpConsoleStore.getState();
    expect(state.frame).toBe('tools');
    expect(state.server).toBe('supl');
    expect(state.directory).toBe('/work/one');
    expect(state.directoryIsCurrent).toBe(false);
    expect(state.toolsLoading).toBe(true);
  });

  test('a catalog answer lands, and a failure lands as its message', async () => {
    useMcpConsoleStore.getState().open({ server: 'supl' });
    toolsDeferred.resolve([sampleTool]);
    await 1;
    expect(useMcpConsoleStore.getState().tools).toEqual([sampleTool]);
    expect(useMcpConsoleStore.getState().toolsLoading).toBe(false);

    toolsDeferred = deferred();
    useMcpConsoleStore.getState().selectServer('supl');
    toolsDeferred.reject(new Error('spawn failed'));
    await flush();
    expect(useMcpConsoleStore.getState().toolsError).toBe('spawn failed');
    expect(useMcpConsoleStore.getState().toolsLoading).toBe(false);
  });

  test('goBack walks the run frame back to tools, then to servers', () => {
    useMcpConsoleStore.getState().open({ server: 'supl' });
    useMcpConsoleStore.getState().selectTool(sampleTool);
    expect(useMcpConsoleStore.getState().frame).toBe('run');
    useMcpConsoleStore.getState().goBack();
    expect(useMcpConsoleStore.getState().frame).toBe('tools');
    expect(useMcpConsoleStore.getState().tool).toBeNull();
    useMcpConsoleStore.getState().goBack();
    const state = useMcpConsoleStore.getState();
    expect(state.frame).toBe('servers');
    expect(state.server).toBeNull();
  });

  test('a finished call lands in the run frame', async () => {
    useMcpConsoleStore.getState().open({ server: 'supl' });
    useMcpConsoleStore.getState().selectTool(sampleTool);
    void callConsoleTool('supl', 'echo', { a: 1 }, null);
    expect(useMcpConsoleStore.getState().isCalling).toBe(true);
    callDeferred.resolve(sampleCall);
    await 1;
    expect(useMcpConsoleStore.getState().lastCall).toEqual(sampleCall);
    expect(useMcpConsoleStore.getState().isCalling).toBe(false);
  });

  test('an answer to a call navigated away from is dropped', async () => {
    useMcpConsoleStore.getState().open({ server: 'supl' });
    useMcpConsoleStore.getState().selectTool(sampleTool);
    void callConsoleTool('supl', 'echo', {}, null);
    useMcpConsoleStore.getState().goBack();
    callDeferred.resolve(sampleCall);
    await 1;
    expect(useMcpConsoleStore.getState().lastCall).toBeNull();
    expect(useMcpConsoleStore.getState().isCalling).toBe(false);
  });

  test('a rejected call lands as its message, not as a result', async () => {
    useMcpConsoleStore.getState().open({ server: 'supl' });
    useMcpConsoleStore.getState().selectTool(sampleTool);
    void callConsoleTool('supl', 'echo', {}, null);
    callDeferred.reject(new Error('502 upstream'));
    await 1;
    expect(useMcpConsoleStore.getState().callError).toBe('502 upstream');
    expect(useMcpConsoleStore.getState().lastCall).toBeNull();
  });

  test('the catalog walks every server and one dead row does not stop the rest', async () => {
    const alive = deferred<McpConsoleTool[]>();
    const dead = deferred<McpConsoleTool[]>();
    toolsByName.set('alive', alive);
    toolsByName.set('dead', dead);
    useMcpConsoleStore.getState().openCatalog();
    expect(useMcpConsoleStore.getState().frame).toBe('catalog');
    expect(useMcpConsoleStore.getState().catalogLoading).toBe(true);

    serversDeferred.resolve([serverRow('alive'), serverRow('dead')]);
    await 1;
    // The list appears before any server answered, rows still reading.
    expect(useMcpConsoleStore.getState().catalogEntries.map((row) => row.name)).toEqual(['alive', 'dead']);
    expect(useMcpConsoleStore.getState().catalogEntries[0].tools).toBeNull();

    alive.resolve([sampleTool]);
    dead.reject(new Error('did not connect'));
    await flush();
    const [first, second] = useMcpConsoleStore.getState().catalogEntries;
    expect(first.tools).toEqual([sampleTool]);
    expect(first.error).toBeNull();
    expect(second.tools).toBeNull();
    expect(second.error).toBe('did not connect');
    expect(useMcpConsoleStore.getState().catalogLoading).toBe(false);
  });

  test('a superseded catalog answer is dropped', async () => {
    const first = deferred<McpConsoleServer[]>();
    const second = deferred<McpConsoleServer[]>();
    serversDeferred = first;
    useMcpConsoleStore.getState().openCatalog();
    serversDeferred = second;
    useMcpConsoleStore.getState().openCatalog();
    // The first opening answers after the second one started; its rows must
    // not paint over the fresh opening that is still waiting.
    first.resolve([serverRow('stale')]);
    await flush();
    expect(useMcpConsoleStore.getState().catalogEntries).toEqual([]);
    second.resolve([serverRow('fresh')]);
    await flush();
    expect(useMcpConsoleStore.getState().catalogEntries.map((row) => row.name)).toEqual(['fresh']);
  });

  test('a catalog row runs its tool and goes back to the catalog', () => {
    useMcpConsoleStore.getState().openCatalog();
    useMcpConsoleStore.getState().selectCatalogTool('other', sampleTool);
    const state = useMcpConsoleStore.getState();
    expect(state.frame).toBe('run');
    expect(state.server).toBe('other');
    expect(state.tool).toEqual(sampleTool);
    useMcpConsoleStore.getState().goBack();
    expect(useMcpConsoleStore.getState().frame).toBe('catalog');
  });
});
