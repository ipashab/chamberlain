// The MCP console's routes, `/api/openchamber/mcp-console/*`, as the panel
// calls them. Every answer is parsed here, once, into the types the dialog
// renders; a shape the server did not send fails the fetch rather than
// putting half-typed rows on screen. The contract is the Routes section of
// `packages/web/server/lib/mcp-console/DOCUMENTATION.md`.

import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';

const SERVERS_ROUTE = '/api/openchamber/mcp-console/servers';
const toolRoute = (server: string) => `${SERVERS_ROUTE}/${encodeURIComponent(server)}/tools`;
const callRoute = (server: string) => `${SERVERS_ROUTE}/${encodeURIComponent(server)}/call`;

// Tool argument schemas and structured outputs are free-form JSON by the
// protocol's nature; the console renders them as text, never typed into rows.
const jsonValueSchema = z.json();

const mcpConsoleServerSchema = z.object({
  name: z.string(),
  type: z.enum(['local', 'remote']),
  scope: z.string().nullable(),
  disabled: z.boolean(),
  codemode: z.boolean(),
  local: z.object({ command: z.array(z.string()) }).nullable(),
  remote: z.object({ origin: z.string().nullable() }).nullable(),
  needsAuth: z.boolean(),
  console: z.object({
    connected: z.boolean(),
    toolsKnown: z.number().int().nullable(),
  }),
});
export type McpConsoleServer = z.infer<typeof mcpConsoleServerSchema>;
const mcpConsoleToolSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: jsonValueSchema.nullable(),
});
export type McpConsoleTool = z.infer<typeof mcpConsoleToolSchema>;

// The catalog frame shows each tool's argument names without a form per
// schema: the MCP spec types inputSchema as a JSON Schema object, so only
// its `properties` and `required` are read, and anything else stays opaque.
const toolInputSummarySchema = z.object({
  properties: z.record(z.string(), z.object({ type: z.string().catch('') })).catch({}),
  required: z.array(z.string()).catch([]),
});

type McpConsoleToolArg = { name: string; type: string; required: boolean };

/** The tool's argument names for the catalog rows; empty when the schema is not the usual object shape. */
export const summarizeToolInput = (tool: McpConsoleTool): McpConsoleToolArg[] => {
  const parsed = toolInputSummarySchema.safeParse(tool.inputSchema);
  if (!parsed.success) return [];
  const required = new Set(parsed.data.required);
  return Object.entries(parsed.data.properties).map(([name, meta]) => ({
    name,
    type: meta.type,
    required: required.has(name),
  }));
};

// Tool arguments are a JSON object per the protocol; the run form parses its
// text once here, so the dialog never narrows a raw JSON.parse result.
const toolArgumentsSchema = z.record(z.string(), z.json());

export type McpConsoleToolArgs = z.output<typeof toolArgumentsSchema>;

/** Parses the run form's JSON text into tool arguments; null when it is not a JSON object. */
export const parseToolArguments = (text: string): McpConsoleToolArgs | null => {
  const trimmed = text.trim();
  if (trimmed === '') return {};
  try {
    const parsed = toolArgumentsSchema.safeParse(JSON.parse(trimmed));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

const toolCallResultSchema = z.object({
  isError: z.boolean(),
  text: z.string().nullable(),
  contentTypes: z.array(z.string()),
  nonTextItems: z.number().int(),
  structured: jsonValueSchema.nullable(),
});

const toolCallAnswerSchema = z.object({
  server: z.string(),
  tool: z.string(),
  durationMs: z.number().int().nonnegative(),
  result: toolCallResultSchema,
});
export type McpConsoleToolCall = z.infer<typeof toolCallAnswerSchema>;

/** A console error carries the server's reason, and a failed local spawn also its stderr tail. */
class McpConsoleError extends Error {
  diagnostics?: string;
}

const raiseConsoleError = async (response: Response, fallback: string): Promise<never> => {
  const body = await response.json().catch(() => null);
  const parsed = z.object({
    error: z.string(),
    diagnostics: z.string().nullish().catch(null),
  }).safeParse(body);
  if (!parsed.success || parsed.data.error.trim() === '') {
    throw new Error(`${fallback}: ${response.status}`);
  }
  const error = new McpConsoleError(parsed.data.error);
  if (parsed.data.diagnostics != null) error.diagnostics = parsed.data.diagnostics;
  throw error;
};

// A console response body: JSON per the routes' contract, or null when the
// fetch failed mid-flight and the .catch below already replaced it.
type ConsoleResponseBody = z.output<typeof jsonValueSchema>;

const parseOrThrow = <T extends z.ZodType>(schema: T, body: ConsoleResponseBody, message: string): z.infer<T> => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new Error(message);
  return parsed.data;
};

const scope = (directory: string | null | undefined) => (directory ? { directory } : {});

export const mcpConsoleApi = {
  /** Every configured server of the scope with its console-side state. */
  servers: async (directory: string | null | undefined): Promise<McpConsoleServer[]> => {
    const response = await runtimeFetch(SERVERS_ROUTE, {
      headers: { accept: 'application/json' },
      ...scope(directory),
    });
    if (!response.ok) await raiseConsoleError(response, 'The MCP server list request failed');
    const body = await response.json().catch(() => null);
    const parsed = parseOrThrow(z.object({ servers: z.array(mcpConsoleServerSchema) }), body, 'The MCP server list response did not match the expected shape');
    return parsed.servers;
  },

  /** One server's tool catalog; the connection and its cache live server-side. */
  tools: async (server: string, directory: string | null | undefined): Promise<McpConsoleTool[]> => {
    const response = await runtimeFetch(toolRoute(server), {
      headers: { accept: 'application/json' },
      ...scope(directory),
    });
    if (!response.ok) await raiseConsoleError(response, 'The tool catalog request failed');
    const body = await response.json().catch(() => null);
    const parsed = parseOrThrow(z.object({ server: z.string(), tools: z.array(mcpConsoleToolSchema) }), body, 'The tool catalog response did not match the expected shape');
    return parsed.tools;
  },

  /** One tool call; `durationMs` and the content projection comes with it. */
  call: async (
    server: string,
    tool: string,
    args: McpConsoleToolArgs,
    directory: string | null | undefined,
  ): Promise<McpConsoleToolCall> => {
    const response = await runtimeFetch(callRoute(server), {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ tool, arguments: args }),
      ...scope(directory),
    });
    if (!response.ok) await raiseConsoleError(response, 'The tool call failed');
    const body = await response.json().catch(() => null);
    return parseOrThrow(toolCallAnswerSchema, body, 'The tool call response did not match the expected shape');
  },
};
