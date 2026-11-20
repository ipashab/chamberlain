/**
 * One live MCP connection for the console: the initialize handshake, the
 * tools catalog, and a tool call. Two transports, one shape —
 *
 * - local servers spawn by `command`, speak newline-delimited JSON-RPC on
 *   stdio, and die with the connection;
 * - remote servers answer JSON-RPC over streamable HTTP: one POST per
 *   request, the reply either a plain JSON body or an SSE stream whose
 *   matching-id event is the response. The session id from the initialize
 *   response rides along on every later request.
 *
 * The connection never retries and never reconnects: the service layer
 * owns lifetimes. Errors are `McpConsoleError` with an HTTP status, so a
 * route can answer them without sniffing at causes.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

import { z } from 'zod';

import type { McpEntity, McpTimeout } from '../opencode/config-v2.js';
import {
  MCP_PROTOCOL_VERSION,
  buildJsonRpcNotification,
  buildJsonRpcRequest,
  createSseMessageReader,
  isErrorResponse,
  isResponseTo,
  jsonRpcErrorStatus,
  parseMessageLine,
  takeCompleteLines,
} from './protocol.js';
import type { JsonRpcMessage, JsonRpcValue } from './protocol.js';

export class McpConsoleError extends Error {
  statusCode: number;
  diagnostics: string | null;

  constructor(message: string, statusCode: number, diagnostics: string | null = null) {
    super(message);
    this.statusCode = statusCode;
    this.diagnostics = diagnostics;
  }
}

/** Для сообщения об ошибке: message упавшего, иначе сам упавший. */
const describeFailure = (error: unknown): unknown =>
  error !== null && typeof error === 'object' && 'message' in error ? error.message ?? error : error;

export interface McpTimeouts {
  startup: number;
  catalog: number;
  execution: number;
}

/** The surface the service layer drives a live connection through. */
export interface McpConsoleConnection {
  request(method: string, params: JsonRpcValue, timeoutMs: number): Promise<JsonRpcValue>;
  notify(method: string, params: JsonRpcValue): void;
  close(): void;
  timeouts: McpTimeouts;
  serverInfo: JsonRpcValue | null;
  stderrTail?: string[];
}

/** One tool off the wire, pared down to what the panel shows. */
export type McpConsoleTool = {
  name: string;
  description: string;
  inputSchema: JsonRpcValue | null;
};

export interface McpConsoleToolResult {
  isError: boolean;
  text: string | null;
  contentTypes: string[];
  nonTextItems: number;
  structured: JsonRpcMessage | null;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 20_000;
const DEFAULT_CATALOG_TIMEOUT_MS = 30_000;
const DEFAULT_EXECUTION_TIMEOUT_MS = 120_000;

/** Phase timeouts from the server's config entry, gaps filled with defaults. */
const effectiveTimeouts = (configured: McpTimeout | undefined): McpTimeouts => ({
  startup: configured?.startup ?? DEFAULT_STARTUP_TIMEOUT_MS,
  catalog: configured?.catalog ?? DEFAULT_CATALOG_TIMEOUT_MS,
  execution: configured?.execution ?? DEFAULT_EXECUTION_TIMEOUT_MS,
});

const INITIALIZE_PARAMS = () => ({
  protocolVersion: MCP_PROTOCOL_VERSION,
  capabilities: {},
  clientInfo: { name: 'openchamber', version: '2.4.0' },
});

// A tool off the wire, parsed to what the panel shows; a tool that is not
// even the usual object renders as an empty row rather than crashing the walk.
const connectionToolSchema = z.object({
  name: z.string().catch(''),
  description: z.string().catch(''),
  inputSchema: z.json().nullable().catch(null),
});

/**
 * The error text of a JSON-RPC error response: a missing or null message
 * falls back, and any other value keeps the way `Error` itself stringifies
 * it.
 */
const errorText = (value: JsonRpcValue | undefined, fallback: string): string =>
  value == null ? fallback : String(value);

/** Tools with only what the panel shows: name, description, input schema. */
const sanitizeTool = (tool: unknown): McpConsoleTool => {
  const parsed = connectionToolSchema.safeParse(tool);
  return parsed.success ? parsed.data : { name: '', description: '', inputSchema: null };
};

interface PendingRequest {
  resolve: (value: JsonRpcValue) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

class StdioConnection implements McpConsoleConnection {
  childProcess: ChildProcessByStdio<Writable, Readable, Readable>;
  timeouts: McpTimeouts;
  nextId = 1;
  pending = new Map<JsonRpcValue, PendingRequest>();
  buffer = '';
  closed = false;
  stderrTail: string[] = [];
  serverInfo: JsonRpcValue | null = null;

  constructor({ childProcess, timeouts }: { childProcess: ChildProcessByStdio<Writable, Readable, Readable>; timeouts: McpTimeouts }) {
    this.childProcess = childProcess;
    this.timeouts = timeouts;

    childProcess.stdout?.setEncoding?.('utf8');
    childProcess.stderr?.setEncoding?.('utf8');
    childProcess.on('exit', () => {
      this.closed = true;
      const error = new McpConsoleError('the MCP server exited before answering', 502);
      for (const { reject } of this.pending.values()) reject(error);
      this.pending.clear();
    });
    // A spawn failure (a missing binary, a locked cwd) reports itself here
    // and may never fire `exit`; without this the request would hang until
    // its own timeout, hiding the real reason.
    childProcess.on('error', (failure) => {
      this.closed = true;
      const reason = String(failure?.message ?? failure ?? 'the MCP server process could not start');
      this.stderrTail.push(`${reason}\n`);
      const error = new McpConsoleError(`the MCP server process could not start: ${reason}`, 502, reason);
      for (const { reject } of this.pending.values()) reject(error);
      this.pending.clear();
    });
    childProcess.stdout.on('data', (chunk: string) => {
      const { buffer, lines } = takeCompleteLines(this.buffer, chunk);
      this.buffer = buffer;
      for (const line of lines) {
        this.receive(parseMessageLine(line));
      }
    });
    childProcess.stderr.on('data', (chunk: string) => {
      // The tail is the only diagnostic a silently dead spawn leaves behind.
      this.stderrTail.push(String(chunk));
      if (this.stderrTail.join('').length > 8_000) this.stderrTail.splice(0, 1);
    });
  }

  receive(message: JsonRpcMessage | null): void {
    if (message == null) return;
    if (message.id == null) return; // Notifications carry no answer to wait for.
    const pending = this.pending.get(message.id);
    if (pending == null) return;
    if (isErrorResponse(message)) {
      pending.reject(new McpConsoleError(
        errorText(message.error?.message, 'the MCP server reported an error'),
        jsonRpcErrorStatus(message.error?.code),
      ));
    } else {
      pending.resolve(message.result ?? {});
    }
  }

  request(method: string, params: JsonRpcValue, timeoutMs: number): Promise<JsonRpcValue> {
    if (this.closed) {
      return Promise.reject(new McpConsoleError('the MCP server connection is closed', 502));
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<JsonRpcValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpConsoleError(`the MCP server did not answer ${method} in time`, 504));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.childProcess.stdin.write(`${buildJsonRpcRequest(id, method, params)}\n`);
    });
  }

  notify(method: string, params: JsonRpcValue): void {
    if (this.closed) return;
    this.childProcess.stdin.write(`${buildJsonRpcNotification(method, params)}\n`);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.childProcess.stdin.end();
    } catch {
      // Already gone — the exit path settled the pending requests.
    }
    const killTimer = setTimeout(() => {
      if (this.childProcess.exitCode == null && !this.childProcess.killed) {
        try {
          this.childProcess.kill('SIGKILL');
        } catch {
          // Never started: nothing to kill.
        }
      }
    }, 3_000);
    killTimer.unref?.();
    try {
      this.childProcess.kill('SIGTERM');
    } catch {
      // Never started: nothing to kill.
    }
  }
}

class StreamableHttpConnection implements McpConsoleConnection {
  url: string;
  headers: Record<string, string>;
  timeouts: McpTimeouts;
  fetch: typeof globalThis.fetch;
  sessionId: string | null = null;
  nextId = 1;
  serverInfo: JsonRpcValue | null = null;

  constructor({ url, headers, timeouts, fetchImpl }: { url: string; headers: Record<string, string> | undefined; timeouts: McpTimeouts; fetchImpl: typeof globalThis.fetch }) {
    this.url = url;
    this.headers = headers ?? {};
    this.timeouts = timeouts;
    this.fetch = fetchImpl;
  }

  async request(method: string, params: JsonRpcValue, timeoutMs: number): Promise<JsonRpcValue> {
    const id = this.nextId;
    this.nextId += 1;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...this.headers,
    };
    if (this.sessionId != null) headers['mcp-session-id'] = this.sessionId;
    const response = await this.fetch(this.url, {
      method: 'POST',
      headers,
      body: buildJsonRpcRequest(id, method, params),
      signal: AbortSignal.timeout(timeoutMs),
    });
    // `Headers#get` answers string or null by its own contract.
    const sessionHeader = response.headers?.get?.('mcp-session-id');
    if (sessionHeader != null && sessionHeader !== '') this.sessionId = sessionHeader;
    if (!response.ok) {
      throw new McpConsoleError(`the MCP server answered HTTP ${response.status}`, response.status >= 500 ? 502 : 400);
    }
    const contentType = response.headers?.get?.('content-type') ?? '';
    let message: JsonRpcMessage | null = null;
    if (contentType.includes('text/event-stream')) {
      message = await this.readSseResponse(response, id);
    } else {
      message = await response.json().catch(() => null);
      if (message != null && message.id !== id) message = null;
    }
    if (message == null) {
      throw new McpConsoleError(`the MCP server did not answer ${method}`, 502);
    }
    if (isErrorResponse(message)) {
      throw new McpConsoleError(
        errorText(message.error?.message, 'the MCP server reported an error'),
        jsonRpcErrorStatus(message.error?.code),
      );
    }
    return message.result ?? {};
  }

  /** Reads SSE events until the one carrying our response id shows up. */
  async readSseResponse(response: Response, id: number): Promise<JsonRpcMessage | null> {
    const readSse = createSseMessageReader();
    const body = response.body;
    if (!body) throw new McpConsoleError('the MCP server answered without a body to read', 502);
    const reader = body.getReader();
    try {
      // One chunk can hold many events; a long tool call streams progress
      // notifications first, so the loop may spin without producing the
      // answer for a while.
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return null;
        const text = value instanceof Uint8Array ? Buffer.from(value).toString('utf8') : String(value);
        for (const message of readSse(text)) {
          if (isResponseTo(message, id)) return message;
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  notify(): void {
    // Streamable HTTP has no persistent channel from us: notifications ride
    // as one-shot POSTs. The initialized notification is the only one the
    // handshake needs, and servers accept its absence over plain request/
    // response flows.
  }

  close(): void {
    // Nothing to close: every request was its own HTTP exchange.
  }
}

const handshakes = (connection: McpConsoleConnection, timeouts: McpTimeouts): Promise<JsonRpcValue> => {
  const result = connection.request('initialize', INITIALIZE_PARAMS(), timeouts.startup);
  return result.then((capabilities) => {
    connection.notify('notifications/initialized', {});
    return capabilities;
  });
};

export interface McpConsoleConnectDependencies {
  spawn?: typeof nodeSpawn;
  fetch?: typeof globalThis.fetch;
}

/**
 * A JSON value read as the object the protocol means: everything else
 * answers as an empty record, the same way reading a field off a primitive
 * answered undefined before.
 */
const asJsonObject = (value: JsonRpcValue): JsonRpcMessage =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};

/**
 * Runs the full handshake and returns a live connection. `config` is a
 * config-entity server entry: local needs `command` (spawned with the
 * server's own environment on top of ours), remote needs `url`.
 */
export const connectMcpServer = async (config: McpEntity, dependencies: McpConsoleConnectDependencies = {}): Promise<McpConsoleConnection> => {
  // The spawner and fetcher are injectable for tests and default to Node's
  // own: the production service calls this with nothing.
  const spawnModule = dependencies.spawn ?? nodeSpawn;
  const fetchImpl = dependencies.fetch ?? globalThis.fetch?.bind(globalThis);
  const timeouts = effectiveTimeouts(config.timeout);
  let connection: McpConsoleConnection;
  if (config.type === 'local') {
    const [command, ...commandArgs] = Array.isArray(config.command) ? config.command : [];
    if (!command) {
      throw new McpConsoleError('the MCP server entry has no command to run', 400);
    }
    const child = spawnModule(command, commandArgs, {
      cwd: config.cwd && config.cwd !== '' ? config.cwd : undefined,
      env: { ...process.env, ...(config.environment ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    connection = new StdioConnection({ childProcess: child, timeouts });
  } else if (config.type === 'remote') {
    const parsedUrl = z.string().min(1).safeParse(config.url);
    if (!parsedUrl.success) {
      throw new McpConsoleError('the MCP server entry has no url to reach', 400);
    }
    if (config.protocol === 'legacy') {
      // The old SSE-and-endpoint transport needs a persistent GET stream the
      // console's one-request flow never opens; streamable HTTP only.
      throw new McpConsoleError('the legacy SSE transport is not supported; the console speaks streamable HTTP only', 400);
    }
    connection = new StreamableHttpConnection({
      url: parsedUrl.data,
      headers: config.headers,
      timeouts,
      fetchImpl,
    });
  } else {
    throw new McpConsoleError(`unknown MCP server type: ${String(config.type)}`, 400);
  }
  try {
    const capabilities = await handshakes(connection, timeouts);
    connection.serverInfo = asJsonObject(capabilities).serverInfo ?? null;
  } catch (error) {
    connection.close?.();
    const stderrTail = connection.stderrTail?.join('').trim() ?? '';
    if (error instanceof McpConsoleError) {
      throw new McpConsoleError(error.message, error.statusCode, stderrTail !== '' ? stderrTail : null);
    }
    throw new McpConsoleError(`the MCP server connection failed: ${String(describeFailure(error))}`, 502);
  }
  return connection;
};

/** The tools catalog, cursor pages walked to the end. */
export const listConnectionTools = async (connection: McpConsoleConnection, timeoutMs: number): Promise<McpConsoleTool[]> => {
  const tools: McpConsoleTool[] = [];
  let cursor: string | null | undefined = undefined;
  // A server that keeps feeding cursors would loop forever; the cap is high
  // enough for every real catalog and cheap as a betrayal clause.
  for (let page = 0; page < 100; page += 1) {
    const result = await connection.request('tools/list', cursor != null ? { cursor } : {}, timeoutMs);
    const record = asJsonObject(result);
    for (const tool of Array.isArray(record.tools) ? record.tools : []) {
      tools.push(sanitizeTool(tool));
    }
    cursor = z.string().min(1).nullable().catch(null).parse(record.nextCursor);
    if (cursor == null) break;
  }
  return tools;
};

const structuredContentSchema = z.record(z.string(), z.json()).nullable().catch(null);

/** One tool call; `arguments` must be a JSON object per the protocol. */
export const callConnectionTool = async (connection: McpConsoleConnection, name: string, args: JsonRpcValue, timeoutMs: number): Promise<McpConsoleToolResult> => {
  const result = await connection.request('tools/call', { name, arguments: args }, timeoutMs);
  // The answer is one JSON-RPC `result`; everything the panel shows of its
  // `content` derives from this parse, so junk fields fall back, not crash.
  const contentItemSchema = z.object({
    type: z.string().catch('unknown'),
    text: z.string().catch(''),
  }).loose();
  const record = asJsonObject(result);
  const content = z.array(contentItemSchema).catch([]).parse(record.content);
  const text = content.filter((item) => item.type === 'text').map((item) => item.text).join('\n');
  const nonText = content.filter((item) => item.type !== 'text').length;
  return {
    isError: z.boolean().catch(false).parse(record.isError),
    text: text === '' && content.length > 0 ? null : text,
    contentTypes: [...new Set(content.map((item) => item.type))],
    nonTextItems: nonText,
    structured: structuredContentSchema.parse(record.structuredContent),
  };
};
