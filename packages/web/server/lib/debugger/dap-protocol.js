/**
 * Debug Adapter Protocol wire framing (Content-Length headers) for the
 * debugger service. Pure text and message handling only: no sockets, no
 * timing, no policy. The service owns the connection lifecycle.
 *
 * Frame shape is the DAP base protocol:
 *   Content-Length: <bytes>\r\n\r\n<bytes of UTF-8 JSON>
 */

const HEADER_SEPARATOR = '\r\n\r\n';
const CONTENT_LENGTH_HEADER = /^content-length:/i;
const MAX_HEADER_CHARS = 64 * 1024;
// A guard against adapters that stop sending usable data. DAP replies to a
// single request are a few KB; state dumps with many variables reach tens of
// KB. Anything past this means the framing is lost, not a big message.
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/** Crafts one outgoing DAP request message with its sequence number. */
export function buildDapRequest(seq, command, args) {
  const message = { seq, type: 'request', command };
  if (args !== undefined) {
    message.arguments = args;
  }
  return message;
}

/** Encodes one DAP message (request, response or event) into its wire frame. */
export function encodeDapMessage(message) {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, 'utf8')}${HEADER_SEPARATOR}${body}`;
}

/**
 * Feeds raw socket text into the frame parser and returns every complete
 * message. Keeps the unparsed remainder in the state buffer. Malformed or
 * oversized data throws: the caller drops the connection rather than
 * trying to resynchronize mid-stream.
 */
export function decodeDapChunk(state, chunk) {
  state.buffer += chunk;
  const messages = [];
  for (;;) {
    const separatorIndex = state.buffer.indexOf(HEADER_SEPARATOR);
    if (separatorIndex === -1) {
      // A header longer than any legal request head can never complete.
      if (state.buffer.length > MAX_HEADER_CHARS) throw new Error('DAP frame header exceeds the size limit');
      return messages;
    }
    const headerLines = state.buffer.slice(0, separatorIndex).split('\r\n');
    let contentLength = -1;
    for (const line of headerLines) {
      if (CONTENT_LENGTH_HEADER.test(line)) {
        const raw = line.slice(line.indexOf(':') + 1).trim();
        const parsed = Number.parseInt(raw, 10);
        if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`Invalid DAP Content-Length: ${raw}`);
        contentLength = parsed;
      }
    }
    if (contentLength === -1) throw new Error('DAP frame is missing Content-Length');
    const bodyStart = separatorIndex + HEADER_SEPARATOR.length;
    // Bodies are byte-counted while the stream is treated as UTF-8 text, so
    // waiting on characters matches waiting on bytes for complete frames.
    if (state.buffer.length - bodyStart < contentLength) return messages;
    if (contentLength > MAX_FRAME_BYTES) throw new Error('DAP frame exceeds the size limit');
    const body = state.buffer.slice(bodyStart, bodyStart + contentLength);
    state.buffer = state.buffer.slice(bodyStart + contentLength);
    try {
      messages.push(JSON.parse(body));
    } catch {
      throw new Error('DAP frame body is not valid JSON');
    }
  }
}
