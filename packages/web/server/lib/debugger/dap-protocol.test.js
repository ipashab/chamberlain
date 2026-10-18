import { describe, expect, it } from 'vitest';

import { buildDapRequest, decodeDapChunk, encodeDapMessage } from './dap-protocol.js';

const newParserState = () => ({ buffer: '' });

describe('encodeDapMessage', () => {
  it('frames a request with a byte-accurate Content-Length', () => {
    const frame = encodeDapMessage(buildDapRequest(1, 'initialize', { adapterID: 'debugpy' }));
    const [header, body] = frame.split('\r\n\r\n');
    expect(header).toBe(`Content-Length: ${Buffer.byteLength(body, 'utf8')}`);
    expect(JSON.parse(body)).toEqual({ seq: 1, type: 'request', command: 'initialize', arguments: { adapterID: 'debugpy' } });
  });

  it('omits the arguments key when there are none', () => {
    const frame = encodeDapMessage(buildDapRequest(2, 'disconnect', undefined));
    expect(JSON.parse(frame.split('\r\n\r\n')[1])).toEqual({ seq: 2, type: 'request', command: 'disconnect' });
  });

  it('counts Content-Length in bytes, not characters', () => {
    const frame = encodeDapMessage({ seq: 3, type: 'event', event: 'stopped', body: { reason: 'ок', threadId: 1 } });
    const [header, body] = frame.split('\r\n\r\n');
    expect(Number.parseInt(header.slice(16), 10)).toBe(Buffer.byteLength(body, 'utf8'));
  });
});

describe('decodeDapChunk', () => {
  it('decodes messages split across chunks', () => {
    const state = newParserState();
    const frame = encodeDapMessage({ seq: 1, type: 'event', event: 'initialized' });
    const split = frame.length - 5;
    expect(decodeDapChunk(state, frame.slice(0, split))).toEqual([]);
    expect(decodeDapChunk(state, frame.slice(split))).toEqual([{ seq: 1, type: 'event', event: 'initialized' }]);
  });

  it('decodes several frames in one chunk and keeps the tail', () => {
    const state = newParserState();
    const first = encodeDapMessage({ seq: 1, type: 'response', command: 'stackTrace' });
    const second = encodeDapMessage({ seq: 2, type: 'response', command: 'scopes' });
    const third = encodeDapMessage({ seq: 3, type: 'response', command: 'variables' });
    const received = decodeDapChunk(state, first + second + third.slice(0, 6));
    expect(received.map((message) => message.seq)).toEqual([1, 2]);
    expect(state.buffer.length).toBe(6);
    expect(decodeDapChunk(state, third.slice(6))[0].seq).toBe(3);
  });

  it('survives a frame with a header the parser must not treat as the separator', () => {
    const state = newParserState();
    const frame = `Content-Length: 2\r\nX-Other: a\r\n\r\n{}`; // separator only after every header line
    expect(decodeDapChunk(state, frame)).toEqual([{}]);
  });

  it('rejects a frame without Content-Length', () => {
    const state = newParserState();
    expect(() => decodeDapChunk(state, 'X-Other: 1\r\n\r\n{}')).toThrow('missing Content-Length');
  });

  it('rejects a non-integer Content-Length', () => {
    const state = newParserState();
    expect(() => decodeDapChunk(state, 'Content-Length: soon\r\n\r\n{}')).toThrow('Invalid DAP Content-Length');
  });

  it('rejects a body that is not JSON', () => {
    const state = newParserState();
    const frame = 'Content-Length: 5\r\n\r\nnot{}';
    expect(() => decodeDapChunk(state, frame)).toThrow('not valid JSON');
  });

  it('rejects stream data that never completes a header', () => {
    const state = newParserState();
    expect(() => decodeDapChunk(state, 'x'.repeat(65 * 1024))).toThrow('header exceeds');
  });
});
