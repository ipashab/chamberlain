import { describe, expect, it } from 'vitest';

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

describe('json-rpc builders', () => {
  it('builds a request with the caller-owned id', () => {
    const request = JSON.parse(buildJsonRpcRequest(7, 'tools/list', { cursor: 'x' }));
    expect(request).toEqual({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: { cursor: 'x' } });
  });

  it('builds a notification without an id and defaults empty params', () => {
    const notification = JSON.parse(buildJsonRpcNotification('notifications/initialized'));
    expect(notification).toEqual({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  });

  it('speaks one pinned protocol version', () => {
    expect(MCP_PROTOCOL_VERSION).toBe('2025-06-18');
  });
});

describe('takeCompleteLines', () => {
  it('holds a partial trailing line for the next chunk', () => {
    const first = takeCompleteLines('', '{"jsonrpc');
    expect(first.lines).toEqual([]);
    const second = takeCompleteLines(first.buffer, '":"2.0"}\n');
    expect(second.lines).toEqual(['{"jsonrpc":"2.0"}']);
    expect(second.buffer).toBe('');
  });

  it('releases every complete line of one chunk', () => {
    const { lines, buffer } = takeCompleteLines('', '{"a":1}\n{"a":2}\n{"a":3}\n');
    expect(lines).toEqual(['{"a":1}', '{"a":2}', '{"a":3}']);
    expect(buffer).toBe('');
  });

  it('keeps a tail without a newline buffered', () => {
    const { lines, buffer } = takeCompleteLines('', '{"a":1}\n{"a":2}');
    expect(lines).toEqual(['{"a":1}']);
    expect(buffer).toBe('{"a":2}');
  });
});

describe('parseMessageLine', () => {
  it('accepts a json-rpc message', () => {
    expect(parseMessageLine('{"jsonrpc":"2.0","id":1,"result":{}}')).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {},
    });
  });

  it('tolerates surrounding whitespace and blank lines', () => {
    expect(parseMessageLine('   {"jsonrpc":"2.0","method":"x","params":{}}  ')).not.toBeNull();
    expect(parseMessageLine('')).toBeNull();
    expect(parseMessageLine('   ')).toBeNull();
  });

  it('drops anything that is not a json-rpc object', () => {
    expect(parseMessageLine('server says hello')).toBeNull();
    expect(parseMessageLine('{"id":1,"result":{}}')).toBeNull(); // no jsonrpc field
    expect(parseMessageLine('{"jsonrpc":"1.0","id":1}')).toBeNull(); // wrong version
    expect(parseMessageLine('[{"jsonrpc":"2.0","id":1}]')).toBeNull(); // array, not object
  });
});

describe('createSseMessageReader', () => {
  it('parses one event per chunk', () => {
    const read = createSseMessageReader();
    const messages = read('data: {"jsonrpc":"2.0","id":1,"result":{}}\n\n');
    expect(messages).toEqual([{ jsonrpc: '2.0', id: 1, result: {} }]);
  });

  it('reads CRLF-framed events, the way uvicorn and starlette send them', () => {
    const read = createSseMessageReader();
    const messages = read('event: message\r\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\r\n\r\n');
    expect(messages).toEqual([{ jsonrpc: '2.0', id: 1, result: {} }]);
  });

  it('keeps an event whose CRLF boundary is split across chunks', () => {
    const read = createSseMessageReader();
    expect(read('data: {"jsonrpc":"2.0","id":2,"result":{}}\r')).toEqual([]);
    const messages = read('\n\r\ndata: {"jsonrpc":"2.0","method":"n3"}\r\n\r\n');
    expect(messages).toEqual([{ jsonrpc: '2.0', id: 2, result: {} }, { jsonrpc: '2.0', method: 'n3' }]);
  });

  it('assembles an event from split chunks and joined data lines', () => {
    const read = createSseMessageReader();
    expect(read('data: {"jsonrpc":"2.0"')).toEqual([]);
    const messages = read(',"id":2,"result":{"a":1}}\n\n');
    expect(messages).toEqual([{ jsonrpc: '2.0', id: 2, result: { a: 1 } }]);
  });

  it('returns several events held in one chunk, keeping order', () => {
    const read = createSseMessageReader();
    const chunk = 'data: {"jsonrpc":"2.0","method":"n1"}\n\ndata: {"jsonrpc":"2.0","id":3,"result":{}}\n\n';
    const messages = read(chunk);
    expect(messages).toEqual([
      { jsonrpc: '2.0', method: 'n1' },
      { jsonrpc: '2.0', id: 3, result: {} },
    ]);
  });

  it('skips events without parseable data: comments and keep-alives', () => {
    const read = createSseMessageReader();
    const messages = read(': keep-alive\n\ndata: not json\n\n');
    expect(messages).toEqual([]);
  });
});

describe('response predicates', () => {
  it('matches a response by id and flags errors', () => {
    expect(isResponseTo({ id: 5 }, 5)).toBe(true);
    expect(isResponseTo({ id: 5 }, 6)).toBe(false);
    expect(isResponseTo({ method: 'n' }, undefined)).toBe(false);
    expect(isErrorResponse({ error: { code: -32601 } })).toBe(true);
    expect(isErrorResponse({ result: {} })).toBe(false);
  });

  it('maps json-rpc error codes to http statuses', () => {
    expect(jsonRpcErrorStatus(-32601)).toBe(404);
    expect(jsonRpcErrorStatus(-32602)).toBe(400);
    expect(jsonRpcErrorStatus(-32700)).toBe(400);
    expect(jsonRpcErrorStatus(-32000)).toBe(502);
  });
});
