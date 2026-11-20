/**
 * Console routes for the MCP block: the configured servers with their
 * console state, one server's tool catalog, and a tool call. The scoping
 * directory rides the way every fork route takes it — the
 * `x-opencode-directory` header the UI's runtimeFetch sets, or a
 * `directory` query parameter.
 *
 * These routes run tools on the user's own configured MCP servers, the
 * same trust level the agent's own tool calls already have; nothing here
 * reaches a server the config does not name.
 */

import express from 'express';
import { z } from 'zod';

import { isRecord } from '../shared/guards.js';
import type { Application, Request, Response } from '../shared/http-contracts.js';
import type { createProjectDirectoryRuntime } from '../projects/project-directory-runtime.js';
import { McpConsoleError } from './client.js';
import type { McpConsoleService } from './service.js';

const jsonBody = express.json({ limit: '256kb' });

type DirectoryResolver = ReturnType<typeof createProjectDirectoryRuntime>['resolveOptionalProjectDirectory'];

export interface McpConsoleRouteDependencies {
  mcpConsoleService: McpConsoleService;
  resolveOptionalProjectDirectory: DirectoryResolver;
}

interface RouteFailure {
  statusCode?: unknown;
  message?: unknown;
  diagnostics?: unknown;
  stack?: unknown;
}

const isRouteFailure = (value: unknown): value is RouteFailure =>
  value !== null && (typeof value === 'object' || typeof value === 'function');

// Tool arguments are arbitrary JSON by the protocol's nature; the service
// itself enforces "a plain object or empty", so the schema only pins the
// fields the console owns.
const callBodySchema = z.object({
  tool: z.string().min(1),
});

const respond = async (res: Response, action: () => Promise<unknown>): Promise<Response> => {
  try {
    return res.json(await action());
  } catch (error) {
    const failure = isRouteFailure(error) ? error : undefined;
    const statusCode = failure?.statusCode;
    let status: number;
    if (error instanceof z.ZodError) status = 400;
    else if (typeof statusCode === 'number' && Number.isInteger(statusCode)) status = statusCode;
    else status = 500;
    if (status >= 500) console.error('[mcp-console] request failed:', failure?.stack ?? error);
    const payload: { error: unknown; diagnostics?: unknown } = {
      error: error instanceof z.ZodError
        ? 'the request body did not match what the console expects'
        : failure?.message ?? 'the MCP console request failed',
    };
    if (failure?.diagnostics != null) payload.diagnostics = failure.diagnostics;
    return res.status(status).json(payload);
  }
};

export const registerMcpConsoleRoutes = (app: Application, { mcpConsoleService, resolveOptionalProjectDirectory }: McpConsoleRouteDependencies) => {
  if (mcpConsoleService == null) throw new Error('mcp console routes need an mcp console service');
  if (resolveOptionalProjectDirectory == null) throw new Error('mcp console routes need a directory resolver');

  // The scoping directory is resolved once per request; a malformed one is
  // the caller's 400, never a silent fallthrough to the user-scope stack.
  const scopedDirectory = async (req: Request) => {
    const { directory, error } = await resolveOptionalProjectDirectory(req);
    if (error == null) return directory ?? null;
    throw new McpConsoleError(error, 400);
  };

  app.get('/api/openchamber/mcp-console/servers', async (req, res) => {
    return respond(res, async () => ({ servers: mcpConsoleService.describeServers(await scopedDirectory(req)) }));
  });

  // The route pattern owns the name's presence; an absent one is still the
  // caller's 400 instead of an undefined reaching the service.
  const serverName = (req: Request): string => {
    const name = req.params.name;
    if (!name) throw new McpConsoleError('the server name is missing', 400);
    return name;
  };

  app.get('/api/openchamber/mcp-console/servers/:name/tools', async (req, res) => {
    return respond(res, async () => mcpConsoleService.listTools(serverName(req), await scopedDirectory(req)));
  });

  app.post('/api/openchamber/mcp-console/servers/:name/call', jsonBody, async (req, res) => {
    return respond(res, async () => {
      const body = callBodySchema.parse(req.body ?? {});
      // Arguments pass through as-is; the service is the one boundary that
      // judges "a plain object or empty" and answers a 400 the panel shows.
      const source = isRecord(req.body) ? req.body : {};
      return mcpConsoleService.callTool(
        serverName(req),
        body.tool,
        source.arguments,
        await scopedDirectory(req),
      );
    });
  });
};
