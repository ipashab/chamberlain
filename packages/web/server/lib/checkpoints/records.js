import { isString } from '../shared/guards.js';
import { readToolRecord } from '../advisor/records.js';

// The files an agent turn touched, read from the session's message pages the
// same way the advisor reads its review records: the newest user message is
// the turn boundary, and every completed `edit`, `write` or `patch` call after
// it names a file. Where the advisor consumes the payloads (old/new strings,
// patch text) to review text, checkpoints keep only the paths, which become
// the restore scope of the turn's checkpoint. `readToolRecord` comes from the
// advisor module rather than a second copy because it is a pure v2 part
// parser, the way the advisor itself imports `newestContentId` from
// session-assist instead of duplicating it.

const PAGE_SIZE = 50;
const MAX_PAGES = 4;

const TRANSPARENT_TYPES = new Set(['idle', 'agent-switched', 'model-switched', 'location-switched']);

const isTransparent = (record) => {
  if (record?.type === 'idle') return record.outcome === 'succeeded';
  return TRANSPARENT_TYPES.has(record?.type);
};

const readHumanText = (record) => {
  if (record?.type !== 'user') return null;
  const text = record.text && record.text.trim() ? record.text : '';
  if (text) return text;
  const context = record.metadata?.openchamberContext;
  return isString(context?.text) ? context.text : null;
};

// The turn's shape: which user message it answers and which files its
// completed `edit`, `write` or `patch` calls touched, first seen first.
const extractTurnFiles = (messages, boundaryIndex) => {
  let lastAssistantID = '';
  const files = new Map();
  for (const message of messages.slice(boundaryIndex + 1)) {
    if (message.role !== 'assistant') continue;
    if (message.id) lastAssistantID = message.id;
    for (const part of message.parts) {
      const record = readToolRecord(part);
      if (record && !files.has(record.path)) files.set(record.path, true);
    }
  }
  if (!lastAssistantID || files.size === 0) return null;
  return { userMessageID: messages[boundaryIndex].id, lastAssistantID, files: Array.from(files.keys()) };
};

/**
 * Files of the newest complete turn, and the message that started it. The
 * user message is the checkpoint's identity; the assistant message serves the
 * runtime's staleness check. `null` means no turn with file-changing calls
 * was found within the bounded read. Failure is thrown (an unreachable
 * session, a failed page, circular pagination).
 */
export async function collectTurnFiles({ readPage, signal }) {
  let chronological = [];
  let cursor;
  const cursors = new Set();
  const ids = new Set();
  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber++) {
    signal.throwIfAborted();
    const page = await readPage({ limit: PAGE_SIZE, cursor });
    signal.throwIfAborted();
    if (!Array.isArray(page?.data)) throw new Error('Session message page is unavailable');
    const older = [];
    for (const record of page.data) {
      if (!record?.id || ids.has(record.id)) continue;
      ids.add(record.id);
      if (isTransparent(record)) continue;
      older.push({
        id: record.id,
        role: record.type,
        text: readHumanText(record),
        parts: Array.isArray(record.content) ? record.content : [],
      });
    }
    older.reverse();
    chronological = older.concat(chronological);
    // The turn boundary is known only once the newest user message is inside
    // the read; pagination stops as soon as it is.
    const boundaryIndex = chronological.findLastIndex((message) => message.role === 'user' && message.text);
    if (boundaryIndex >= 0) return extractTurnFiles(chronological, boundaryIndex);
    const next = isString(page.cursor?.next) ? page.cursor.next : null;
    if (!next || cursors.has(next)) return null;
    cursors.add(next);
    cursor = next;
  }
  return null;
}
