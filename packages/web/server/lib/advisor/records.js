import { isRecord, isString } from '../shared/guards.js';

// The turn's file-changing tool calls, read from the session's message pages.
// This reader is the advisor's only source of what a turn touched: the recap
// reader (`../session-assist/context.js`) folds tool payloads away, so this
// one goes the other way and keeps only the completed `edit`, `write` and
// `patch` calls between the newest human message and the end of history.

const PAGE_SIZE = 50;
const MAX_PAGES = 4;
const SNIPPET_CHAR_LIMIT = 600;
const DIGEST_FILE_LIMIT = 10;
const DIGEST_CHAR_BUDGET = 12_000;

// Mirrors `packages/ui/src/lib/opencode/tools.ts` `normalizeToolName`; server
// code cannot import the UI package, so the comparable form is kept here. The
// UI one stays canonical: a change to tool naming lands there first.
export function normalizeToolName(toolName) {
  const trimmed = isString(toolName) ? toolName.trim().toLowerCase() : '';
  if (!trimmed) return '';
  const withoutIndex = trimmed.replace(/:\d+$/, '');
  if (!withoutIndex.includes('.')) return withoutIndex;
  const segments = withoutIndex.split('.').filter(Boolean);
  return segments[segments.length - 1] ?? withoutIndex;
}

const readPath = (input) => {
  const value = input?.path ?? input?.filePath ?? input?.file_path;
  return isString(value) ? value.trim() : '';
};

/**
 * One completed file-changing call. `kind` is the comparable tool name, `path`
 * stays as the tool wrote it (anchor checks resolve it against the session's
 * directory); the payload fields follow the tool: `oldString`/`newString`,
 * `content`, or a full unified diff in `patchText`.
 */
export function readToolRecord(part) {
  const state = part?.state;
  if (!isRecord(state) || state.status !== 'completed') return null;
  const input = isRecord(state.input) ? state.input : null;
  if (!input) return null;
  const kind = normalizeToolName(part.tool);
  const path = readPath(input);
  if (!kind || !path) return null;
  const expectString = (value) => (isString(value) ? value : null);
  if (kind === 'edit') {
    const oldString = expectString(input.oldString);
    const newString = expectString(input.newString);
    if (oldString === null || newString === null) return null;
    return { kind, path, oldString, newString, recordId: `${part.id ?? path}:edit` };
  }
  if (kind === 'write') {
    const content = expectString(input.content);
    if (content === null) return null;
    return { kind, path, content, recordId: `${part.id ?? path}:write` };
  }
  if (kind === 'patch') {
    const patchText = expectString(input.patchText ?? input.patch_text ?? input.patch);
    if (patchText === null) return null;
    return { kind, path, patchText, recordId: `${part.id ?? path}:patch` };
  }
  return null;
}

const TRANSPARENT_TYPES = new Set(['idle', 'agent-switched', 'model-switched', 'location-switched']);

const isTransparent = (record) => {
  if (record?.type === 'idle') return record.outcome === 'succeeded';
  return TRANSPARENT_TYPES.has(record?.type);
};

const readHumanText = (record) => {
  if (record?.type !== 'user') return null;
  return isString(record.text) && record.text.trim() ? record.text : (record.metadata?.openchamberContext?.text ?? '');
};

/**
 * The text a rule sees: what the call added to the file. A patch contributes
 * only its `+` lines, so context markers never count as added text.
 */
export function addedText(record) {
  if (record.kind === 'edit') return record.newString;
  if (record.kind === 'write') return record.content;
  if (record.kind !== 'patch') return '';
  return record.patchText
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n');
}

/** The last completed call per file; a later call supersedes an earlier one. */
export function lastRecordPerFile(records) {
  const last = new Map();
  for (const record of records) {
    if (record.kind === 'patch') continue;
    last.set(record.path, record);
  }
  return last;
}

function excerpt(text, limit) {
  if (text.length <= limit) return text;
  const marker = '\n[Content omitted]\n';
  const head = Math.ceil((limit - marker.length) / 2);
  const tail = limit - marker.length - head;
  return `${text.slice(0, head)}${marker}${text.slice(-Math.max(0, tail))}`;
}

const describeRecord = (record) => {
  const header = `${record.kind} ${record.path}`;
  if (record.kind === 'edit') {
    return `${header}\n--- old\n${excerpt(record.oldString, SNIPPET_CHAR_LIMIT)}\n+++ new\n${excerpt(record.newString, SNIPPET_CHAR_LIMIT)}`;
  }
  if (record.kind === 'write') {
    return `${header} (${record.content.length} chars)\n${excerpt(record.content, SNIPPET_CHAR_LIMIT)}`;
  }
  return `${header} (patch)\n${excerpt(record.patchText, SNIPPET_CHAR_LIMIT)}`;
};

/**
 * The model-facing review digest: one block per call, newest work last,
 * bounded to `DIGEST_CHAR_LIMIT` files and characters. Records are cut from
 * the front (the budget spends itself on the newest calls first) and the
 * digest says when it dropped work, so the model cannot mistake truncation
 * for the whole turn.
 */
export function buildReviewDigest(records) {
  const blocks = [];
  let budget = DIGEST_CHAR_BUDGET;
  let dropped = 0;
  for (const record of [...records].reverse()) {
    if (blocks.length >= DIGEST_FILE_LIMIT || budget <= 0) {
      dropped += 1;
      continue;
    }
    const block = describeRecord(record);
    const chunk = block.length <= budget ? block : `${excerpt(block, budget)}`;
    budget -= chunk.length;
    if (!chunk.trim()) {
      dropped += 1;
      continue;
    }
    blocks.unshift(chunk);
  }
  if (!blocks.length) return '';
  const suffix = dropped > 0 ? `\n\n[${dropped} earlier change(s) omitted for size]` : '';
  return blocks.join('\n\n') + suffix;
}

const extractTurnToolRecords = (messages) => {
  const boundary = messages.findLastIndex((message) => message.role === 'user' && message.text);
  if (boundary < 0) return null;
  const records = [];
  let lastAssistantId = '';
  let preferred = null;
  let humanText = '';
  for (const message of messages.slice(boundary)) {
    if (message.role === 'user') {
      if (!humanText) humanText = message.text;
      continue;
    }
    if (message.role !== 'assistant') continue;
    if (message.id) lastAssistantId = message.id;
    if (message.model) preferred = message.model;
    for (const part of message.parts) {
      const record = readToolRecord(part);
      if (record) records.push(record);
    }
  }
  if (!records.length) return null;
  return { records, lastAssistantId, preferred, humanText };
};

/**
 * Failure is thrown (an unreachable session, a failed page, circular
 * pagination); null means no complete turn with file-changing calls was found
 * within the bounded read.
 */
export async function collectTurnEdits({ readPage, signal }) {
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
        model: record.model ? { providerID: record.model.providerID, modelID: record.model.id } : null,
      });
    }
    older.reverse();
    chronological = older.concat(chronological);
    const next = isString(page.cursor?.next) ? page.cursor.next : null;
    // The turn boundary is known only once the newest user message is inside
    // the read; pagination stops as soon as it is.
    const turn = extractTurnToolRecords(chronological);
    if (turn) return turn;
    if (!next || pageNumber === MAX_PAGES - 1) break;
    if (cursors.has(next)) throw new Error('Session message pagination made no progress');
    cursors.add(next);
    cursor = next;
  }
  return null;
}
