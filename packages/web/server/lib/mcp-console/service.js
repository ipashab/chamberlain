/**
 * The MCP console's server-side lifetime: OpenCode config entries in, one
 * live connection per configured server out.
 *
 * Connections are kept, not opened per request: a tool that keeps state in
 * its server (a browser it opened, a session it holds) answers the second
 * call the way the user expects, and a spawned stdio server costs its
 * startup once. Each idle connection closes after a timer, so nothing
 * accumulates. Catalogs cache per connection and die with it.
 *
 * Config entries can carry secrets — local `environment`, remote `headers`
 * with tokens, URLs with embedded credentials. Those never leave this
 * module's boundary: `describeServers` answers command words and an origin,
 * a tool call returns tool output, and nothing else.
 */

import { z } from 'zod';

import { getMcpConfig, listMcpConfigs } from '../opencode/mcp.js';
import {
  McpConsoleError,
  callConnectionTool,
  connectMcpServer,
  listConnectionTools,
} from './client.js';

const IDLE_SHUTDOWN_MS = 15 * 60_000;

const entryKey = (directory, name) => `${directory ?? ''}\u0000${name}`;

const originOfUrl = (url) => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

/** The public shape of one configured server; no secrets ride along. */
const describeConfigEntry = (entry, state) => ({
  name: entry.name,
  type: entry.type,
  scope: entry.scope ?? null,
  disabled: entry.disabled === true,
  codemode: entry.codemode === true,
  local: entry.type === 'local'
    ? { command: Array.isArray(entry.command) ? entry.command : [] }
    : null,
  remote: entry.type === 'remote'
    ? { origin: originOfUrl(entry.url ?? '') }
    : null,
  needsAuth: entry.type === 'remote' && entry.oauth != null,
  console: state,
});

export const createMcpConsoleService = (dependencies = {}) => {
  const connect = dependencies.connect ?? connectMcpServer;
  const readCatalog = dependencies.listConnectionTools ?? listConnectionTools;
  const invokeTool = dependencies.callConnectionTool ?? callConnectionTool;
  const getConfig = dependencies.getConfig ?? getMcpConfig;
  const listConfigs = dependencies.listConfigs ?? listMcpConfigs;
  const idleShutdownMs = dependencies.idleShutdownMs ?? IDLE_SHUTDOWN_MS;

  /** One adopted server: the connection, its catalog and its idle timer. */
  const connections = new Map();

  const dropEntry = (entry) => {
    if (entry.idleTimer != null) clearTimeout(entry.idleTimer);
    entry.connection?.close?.();
  };

  const closeIdle = (entry) => {
    entry.idleTimer = null;
    if (connections.get(entry.key) === entry) connections.delete(entry.key);
    dropEntry(entry);
  };

  const touchIdleTimer = (entry) => {
    if (entry.idleTimer != null) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => closeIdle(entry), idleShutdownMs);
    entry.idleTimer.unref?.();
  };

  /**
   * The config entry behind a console request: the named server of the
   * scoped config layers. A missing server is a 404; a remote entry whose
   * auth is an OAuth flow is a 400 — that handshake belongs to OpenCode's
   * own connection, and the console has no one to complete it with.
   */
  const requireConfig = (name, directory) => {
    const routeName = z.string().trim().min(1).safeParse(name);
    if (!routeName.success) {
      throw new McpConsoleError('an MCP server name is required', 400);
    }
    const entry = getConfig(routeName.data, directory ?? null);
    if (entry == null) {
      throw new McpConsoleError(`no MCP server named "${name}" is configured`, 404);
    }
    if (entry.type === 'remote' && entry.oauth != null) {
      throw new McpConsoleError(
        `"${name}" needs an OAuth login the console cannot perform; call its tools through the agent instead`,
        400,
      );
    }
    return entry;
  };

  /**
   * A live connection for the named server, connected on first use. The
   * in-flight handshake is shared: two callers at once get the same
   * connection, and its failure reaches both. A failed entry retires, so
   * the next call opens a fresh one.
   */
  const ensureConnection = async (name, directory) => {
    const config = requireConfig(name, directory);
    const key = entryKey(directory, name);
    const existing = connections.get(key);
    if (existing != null) {
      touchIdleTimer(existing);
      await existing.connectPromise;
      return existing;
    }
    const entry = { key, connection: null, tools: null, idleTimer: null, connectPromise: null };
    connections.set(key, entry);
    entry.connectPromise = (async () => {
      entry.connection = await connect(config);
      touchIdleTimer(entry);
    })();
    try {
      await entry.connectPromise;
    } catch (error) {
      if (connections.get(key) === entry) connections.delete(entry.key);
      dropEntry(entry);
      if (error instanceof McpConsoleError) {
        throw new McpConsoleError(`"${name}" did not connect: ${error.message}`, error.statusCode, error.diagnostics);
      }
      throw new McpConsoleError(`"${name}" did not connect: ${String(error?.message ?? error)}`, 502);
    }
    return entry;
  };

  const requireLiveConnection = (entry) => {
    if (entry?.connection == null) {
      // An entry with no connection sits between retire and rerun; the
      // route can only answer that it closed.
      throw new McpConsoleError('the MCP server connection is closed', 502);
    }
    return entry.connection;
  };

  /** Every configured server with its console-side state; no secrets. */
  const describeServers = (directory) => {
    const listed = listConfigs(directory ?? null);
    const entries = Array.isArray(listed) ? listed : [];
    return entries.map((entry) => {
      const state = connections.get(entryKey(directory, entry.name));
      return describeConfigEntry(entry, {
        connected: state?.connection != null,
        toolsKnown: Array.isArray(state?.tools) ? state.tools.length : null,
      });
    });
  };

  /** The tools catalog of one server, cached until its connection retires. */
  const listTools = async (name, directory) => {
    const entry = await ensureConnection(name, directory);
    if (Array.isArray(entry.tools)) return { server: name, tools: entry.tools };
    const connection = requireLiveConnection(entry);
    const tools = await readCatalog(connection, connection.timeouts.catalog);
    entry.tools = tools;
    touchIdleTimer(entry);
    return { server: name, tools };
  };

  /** One tool call on a live connection; the console's point. */
  const callTool = async (name, tool, args, directory) => {
    const routeTool = z.string().trim().min(1).safeParse(tool);
    if (!routeTool.success) {
      throw new McpConsoleError('a tool name is required', 400);
    }
    const parsedArgs = z.record(z.string(), z.json()).nullable().safeParse(args);
    if (!parsedArgs.success) {
      throw new McpConsoleError('tool arguments must be a JSON object', 400);
    }
    const toolName = routeTool.data;
    const started = Date.now();
    const entry = await ensureConnection(name, directory);
    const connection = requireLiveConnection(entry);
    const known = Array.isArray(entry.tools) ? entry.tools : null;
    if (known != null && !known.some((candidate) => candidate.name === toolName)) {
      // The catalog lives on this connection; a name outside it is a typo
      // the server would reject the same way, so answer without a round
      // trip.
      throw new McpConsoleError(`"${name}" has no tool named "${toolName}"`, 404);
    }
    const result = await invokeTool(connection, toolName, parsedArgs.data ?? {}, connection.timeouts.execution);
    touchIdleTimer(entry);
    return { server: name, tool: toolName, durationMs: Date.now() - started, result };
  };

  /** Test seam: retire every connection the service holds. */
  const closeAll = () => {
    for (const entry of connections.values()) dropEntry(entry);
    connections.clear();
  };

  return { describeServers, listTools, callTool, closeAll };
};
