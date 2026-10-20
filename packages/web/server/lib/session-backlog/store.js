import { asNonEmptyString, isPlainObject, isString } from '../shared/guards.js';
import fsDefault from 'node:fs';
import pathDefault from 'node:path';

// Per-session backlog, one JSON file per session under
// `<dataDir>/backlog/`. Items are prompts the user staged in the dialog
// without running them; the drain hands them to the session in order, one
// turn each. The list is bounded per session, and a session whose list is
// empty keeps its empty file: the store does not learn about session
// deletion, and an empty backlog is a valid state a later message refills.

const LIST_LIMIT = 50;
const TEXT_LIMIT = 50_000;
const STORE_DIRECTORY = 'backlog';

const asTimestamp = (value) => (Number.isSafeInteger(value) && value > 0 ? value : 0);

// The run order of a record: an explicit position (stamped by `move`), or
// nothing staged behind it yet.
const asPosition = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);

const readItem = (value) => {
  if (!isPlainObject(value)) return null;
  const id = asNonEmptyString(value.id);
  const text = isString(value.text) ? value.text : '';
  const createdAt = asTimestamp(value.createdAt);
  const position = asPosition(value.position);
  if (!id || !text.trim() || !createdAt) return null;
  const item = { id, text, createdAt };
  if (position !== null) item.position = position;
  return item;
};

const readStored = (raw, sessionId) => {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`backlog store file is malformed for ${sessionId}`);
  }
  const records = isPlainObject(parsed) && Array.isArray(parsed.items)
    ? parsed.items
    : null;
  if (!records) throw new Error(`backlog store file is malformed for ${sessionId}`);
  const items = [];
  for (const value of records) {
    const item = readItem(value);
    if (item) items.push(item);
  }
  // Oldest first: the drain takes the head of the list, and the head is
  // what a bounded list trims from the back. A record from before reordering
  // exits carries no position and keeps its chronological place; a record
  // staged after a move carries none either and lands behind the last
  // positioned one, newest within that tail by its timestamp.
  const sortKey = (item) => item.position ?? Number.MAX_SAFE_INTEGER;
  items.sort((left, right) => (sortKey(left) - sortKey(right)) || (left.createdAt - right.createdAt));
  return items.slice(0, LIST_LIMIT);
};

/**
 * @param {object} options
 * @param {string} options.dataDir OpenChamber data directory for this instance.
 * @param {typeof fsDefault.promises} [options.fsPromises]
 * @param {typeof pathDefault} [options.path]
 * @param {() => string} [options.generateId] Item ids for new entries.
 */
export const createBacklogStore = ({
  dataDir,
  fsPromises = fsDefault.promises,
  path = pathDefault,
  generateId = () => `bl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
}) => {
  if (!isString(dataDir) || !dataDir.trim()) throw new Error('Backlog store requires a data directory');

  const storeDirectory = path.join(dataDir, STORE_DIRECTORY);
  const filePathOf = (sessionId) => path.join(storeDirectory, `${sessionId}.json`);

  // One read-modify-write at a time per store: without the chain a drain's
  // removal racing the user's next staged item could persist one side's read
  // over the other's write and lose it on disk while both remembered
  // succeeding.
  let transactionChain = Promise.resolve();
  const runExclusive = (work) => {
    const next = transactionChain.then(work, work);
    transactionChain = next.then(() => undefined, () => undefined);
    return next;
  };

  const readFile = async (sessionId) => {
    const filePath = filePathOf(sessionId);
    let raw;
    try {
      raw = await fsPromises.readFile(filePath, 'utf8');
    } catch (error) {
      // No file yet is a session without a backlog, distinct from a failed
      // read: throws stay failures, only ENOENT is a clean empty answer.
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    try {
      return readStored(raw, sessionId);
    } catch (error) {
      // Malformed bytes are kept for the user rather than overwritten by
      // the next write.
      const backup = `${filePath}.corrupt-${Date.now()}`;
      await fsPromises.rename(filePath, backup).catch(() => {});
      console.warn(`[backlog] store file for ${sessionId} was unreadable and was moved to ${backup}`);
      throw error;
    }
  };

  const persist = async (sessionId, items) => {
    const payload = JSON.stringify({ version: 1, items });
    await fsPromises.mkdir(storeDirectory, { recursive: true });
    // Temp file in the same directory so the rename is atomic on one device.
    const tmpPath = `${filePathOf(sessionId)}.${process.pid}.tmp`;
    await fsPromises.writeFile(tmpPath, payload, 'utf8');
    await fsPromises.rename(tmpPath, filePathOf(sessionId));
  };

  return {
    /** Items of one session, oldest first; throws on a failed or malformed read. */
    list: (sessionId) => readFile(sessionId),

    /**
     * Stage one item at the back of the queue. Answers the stored item, or
     * an error name when the text is empty or over the limit or the list is
     * full — an eviction would drop the oldest staged task without the user
     * ever sending it, which is data loss, so the add is refused instead.
     */
    add: (sessionId, { text, createdAt, id }) => runExclusive(async () => {
      const trimmed = isString(text) ? text.trim() : '';
      if (!trimmed) throw new Error('The staged item is empty');
      if (trimmed.length > TEXT_LIMIT) throw new Error(`The staged item is ${trimmed.length} characters; the limit is ${TEXT_LIMIT}`);
      const items = await readFile(sessionId);
      if (items.length >= LIST_LIMIT) throw new Error(`The backlog for this session already holds ${items.length} items; the limit is ${LIST_LIMIT}`);
      const item = readItem({ id: id ?? generateId(), text: trimmed, createdAt });
      if (!item) throw new Error('The staged item could not be recorded');
      items.push(item);
      await persist(sessionId, items);
      return item;
    }),

    /** Take one item out of the queue; answers whether it was there. */
    remove: (sessionId, itemId) => runExclusive(async () => {
      const items = await readFile(sessionId);
      const without = items.filter((item) => item.id !== itemId);
      if (without.length === items.length) return false;
      await persist(sessionId, without);
      return true;
    }),

    /**
     * Move one staged item to a new index in the run order, 0 first. Every
     * record is stamped with its position in the new order, so the file says
     * the order the next read sorts by. Answers the reordered list, or null
     * when the item was not staged.
     */
    move: (sessionId, itemId, position) => runExclusive(async () => {
      const items = await readFile(sessionId);
      if (items.length === 0) throw new Error('The backlog of this session is empty');
      if (!Number.isSafeInteger(position) || position < 0 || position >= items.length) {
        throw new Error(`The target position must be within the queue, 0 to ${items.length - 1}`);
      }
      const from = items.findIndex((item) => item.id === itemId);
      if (from === -1) return null;
      const [moved] = items.splice(from, 1);
      items.splice(position, 0, moved);
      await persist(sessionId, items.map((item, index) => ({ ...item, position: index })));
      return items;
    }),

    /** Drop every staged item; answers how many were dropped. */
    clear: (sessionId) => runExclusive(async () => {
      const items = await readFile(sessionId);
      await persist(sessionId, []);
      return items.length;
    }),
  };
};

export const backlogStoreBounds = Object.freeze({
  listLimit: LIST_LIMIT,
  textLimit: TEXT_LIMIT,
});
