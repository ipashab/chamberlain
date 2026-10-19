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

import { McpConsoleError } from './client.js';

const jsonBody = express.json({ limit: '256kb' });

// Tool arguments are arbitrary JSON by the protocol's nature; the service
// itself enforces "a plain object or empty", so the schema only pins the
// fields the console owns.
const callBodySchema = z.object({
  tool: z.string().min(1),
});

const respond = async (res, action) => {
  try {
    return res.json(await action());
  } catch (error) {
    let status;
    if (error instanceof z.ZodError) status = 400;
    else status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
    if (status >= 500) console.error('[mcp-console] request failed:', error?.stack ?? error);
    const payload = {
      error: error instanceof z.ZodError
        ? 'the request body did not match what the console expects'
        : error?.message ?? 'the MCP console request failed',
    };
    if (error?.diagnostics != null) payload.diagnostics = error.diagnostics;
    return res.status(status).json(payload);
  }
};

export const registerMcpConsoleRoutes = (app, dependencies) => {
  const { mcpConsoleService, resolveOptionalProjectDirectory } = dependencies;
  if (mcpConsoleService == null) throw new Error('mcp console routes need an mcp console service');
  if (resolveOptionalProjectDirectory == null) throw new Error('mcp console routes need a directory resolver');

  // The scoping directory is resolved once per request; a malformed one is
  // the caller's 400, never a silent fallthrough to the user-scope stack.
  const scopedDirectory = async (req) => {
    const { directory, error } = await resolveOptionalProjectDirectory(req);
    if (error == null) return directory ?? null;
    throw new McpConsoleError(error, 400);
  };

  app.get('/api/openchamber/mcp-console/servers', async (req, res) => {
    return respond(res, async () => ({ servers: mcpConsoleService.describeServers(await scopedDirectory(req)) }));
  });

  app.get('/api/openchamber/mcp-console/servers/:name/tools', async (req, res) => {
    return respond(res, async () => mcpConsoleService.listTools(req.params.name, await scopedDirectory(req)));
  });

  app.post('/api/openchamber/mcp-console/servers/:name/call', jsonBody, async (req, res) => {
    return respond(res, async () => {
      const body = callBodySchema.parse(req.body ?? {});
      // Arguments pass through as-is; the service is the one boundary that
      // judges "a plain object or empty" and answers a 400 the panel shows.
      return mcpConsoleService.callTool(
        req.params.name,
        body.tool,
        req.body?.arguments,
        await scopedDirectory(req),
      );
    });
  });
};
