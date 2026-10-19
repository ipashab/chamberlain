/**
 * Pure MCP wire-format helpers for the console connection: JSON-RPC message
 * builders and the two framings the protocol runs over — newline-delimited
 * JSON on stdio, and `data:`-line SSE events for streamable HTTP. No IO
 * lives here, so every rule of the wire is testable without a server.
 */

import { z } from 'zod';

const JSON_RPC_VERSION = '2.0';

export const MCP_PROTOCOL_VERSION = '2025-06-18';

/**
 * Builds a JSON-RPC request. The caller owns the id: a connection's ids
 * must be unique per direction, and only the connection knows what it has
 * already used.
 */
export const buildJsonRpcRequest = (id, method, params) =>
  JSON.stringify({ jsonrpc: JSON_RPC_VERSION, id, method, params: params ?? {} });

/** A notification is a request without an id; no answer ever comes. */
export const buildJsonRpcNotification = (method, params) =>
  JSON.stringify({ jsonrpc: JSON_RPC_VERSION, method, params: params ?? {} });

/**
 * Splits a stdio buffer into whole received lines. stdio MCP frames each
 * JSON-RPC message as one line; a partial trailing line stays buffered for
 * the next chunk.
 */
export const takeCompleteLines = (buffer, chunk) => {
  const combined = buffer + chunk;
  const lastNewline = combined.lastIndexOf('\n');
  if (lastNewline === -1) return { buffer: combined, lines: [] };
  return {
    buffer: combined.slice(lastNewline + 1),
    lines: combined.slice(0, lastNewline).split('\n'),
  };
};

/**
 * Decodes one received line into a message. Blank lines are legal noise; a
 * line that is not a JSON-RPC object is dropped rather than fatal — a
 * chatty local server must not take its whole tool catalog down.
 */
export const parseMessageLine = (line) => {
  const trimmed = line.trim();
  if (trimmed === '') return null;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  // A JSON-RPC message is an object at minimum; the record parse both
  // rejects nulls and arrays and stays the envelope checks' one boundary.
  const message = z.record(z.string(), z.json()).safeParse(parsed);
  if (!message.success) return null;
  if (message.data.jsonrpc !== JSON_RPC_VERSION) return null;
  return message.data;
};

/**
 * Stateful SSE parsing for streamable HTTP responses. Chunks accumulate
 * until a blank line closes an event; `data:` lines of one event join with
 * newlines, and the event's JSON-RPC message is returned. Events without
 * parseable data (keep-alives, comments) are skipped.
 */
export const createSseMessageReader = () => {
  let buffer = '';
  return (chunk) => {
    // Starlette/uvicorn (FastMCP) frame SSE with CRLF while the RFC allows
    // CR, LF or CRLF; normalizing on the combined buffer finds every `\n\n`
    // boundary, and a `\r` that ends a chunk waits for its `\n` instead of
    // faking a line break.
    buffer = (buffer + chunk).replaceAll('\r\n', '\n');
    const messages = [];
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = rawEvent
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (data !== '') {
        try {
          const parsed = JSON.parse(data);
          const message = z.record(z.string(), z.json()).safeParse(parsed);
          if (message.success) {
            messages.push(message.data);
          }
        } catch {
          // Not JSON — ignore this event entirely.
        }
      }
      boundary = buffer.indexOf('\n\n');
    }
    return messages;
  };
};

/** True when a JSON-RPC message is the response to a request with this id. */
export const isResponseTo = (message, id) =>
  message.id != null && message.id === id;

/** True when a JSON-RPC message is an error response. */
export const isErrorResponse = (message) => message.error != null;

/** Maps a JSON-RPC error code to an HTTP-friendly status. */
export const jsonRpcErrorStatus = (code) => {
  if (code === -32601) return 404; // Method not found: no such tool, usually.
  if (code === -32602) return 400; // Invalid params: the arguments were wrong.
  if (code === -32700) return 400; // Parse error.
  return 502;
};
