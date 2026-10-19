import { asNonEmptyString, isPlainObject, isString } from '../shared/guards.js';
import fsDefault from 'node:fs';
import pathDefault from 'node:path';

// Per-session checkpoint registry, one JSON file per session under
// `<dataDir>/checkpoints/`. The entry list is bounded per session, so a file
// is a few kilobytes and pruning is eviction; an evicted entry first hands its
// refs to the runtime's pruner, which drops the pinned trees. A session whose
// last entry is evicted keeps its empty file: the store does not learn about
// session deletion, and an empty registry is a valid state a later turn
// refills.

const LIST_LIMIT = 15;
const FILE_LIMIT = 500;
const STORE_DIRECTORY = 'checkpoints';

const asTree = (value) => (isString(value) && /^[0-9a-f]{40,64}$/i.test(value) ? value : '');

const asRefName = (value) => (
  isString(value) && /^refs\/openchamber\/checkpoints\/[a-zA-Z0-9][a-zA-Z0-9/_-]*$/.test(value) ? value : ''
);

const asTimestamp = (value) => (Number.isSafeInteger(value) && value > 0 ? value : 0);

/** A stored restore record, or null; one undo ref is enough because a newer restore makes the old undo unreachable. */
const readRestored = (value) => {
  if (!isPlainObject(value)) return null;
  const tree = asTree(value.tree);
  const refName = asRefName(value.refName);
  const at = asTimestamp(value.at);
  return tree && refName && at ? { at, tree, refName } : null;
};

const readEntry = (value) => {
  if (!isPlainObject(value)) return null;
  const id = asNonEmptyString(value.id);
  const userMessageID = asNonEmptyString(value.userMessageID);
  const directory = asNonEmptyString(value.directory);
  const tree = asTree(value.tree);
  const baseRefName = asRefName(value.baseRefName);
  const createdAt = asTimestamp(value.createdAt);
  const files = Array.isArray(value.files)
    ? Array.from(new Set(
      value.files.map((file) => (isString(file) && file.trim() ? file.trim() : '')).filter(Boolean),
    ))
    : [];
  if (!id || !userMessageID || !directory || !tree || !baseRefName || !createdAt || files.length === 0) return null;
  const restored = readRestored(value.restored);
  const truncated = value.truncated === true ? true : false;
  const entry = { id, userMessageID, directory, tree, baseRefName, createdAt, files, truncated, restored: null };
  if (restored) entry.restored = restored;
  return entry;
};

const readStored = (raw, sessionId) => {
  const parsed = JSON.parse(raw);
  const records = isPlainObject(parsed) && Array.isArray(parsed.list)
    ? parsed.list
    : null;
  if (!records) throw new Error(`checkpoint store file is malformed for ${sessionId}`);
  const entries = [];
  for (const value of records) {
    const entry = readEntry(value);
    if (entry) entries.push(entry);
  }
  // Newest first: each record puts its entry at the front, and the front is
  // what eviction trims once the list is over the limit.
  entries.sort((left, right) => right.createdAt - left.createdAt);
  return entries.slice(0, LIST_LIMIT);
};

/**
 * @param {object} options
 * @param {string} options.dataDir OpenChamber data directory for this instance.
 * @param {typeof fsDefault.promises} [options.fsPromises]
 * @param {typeof pathDefault} [options.path]
 * @param {(evicted: object[]) => void} [options.onEvicted] Ref cleanup the runtime owns.
 */
export const createCheckpointStore = ({
  dataDir,
  fsPromises = fsDefault.promises,
  path = pathDefault,
  onEvicted = () => {},
}) => {
  if (!isString(dataDir) || !dataDir.trim()) throw new Error('Checkpoint store requires a data directory');

  const storeDirectory = path.join(dataDir, STORE_DIRECTORY);
  const filePathOf = (sessionId) => path.join(storeDirectory, `${sessionId}.json`);

  /**
   * One read-modify-write at a time per store: without the chain a restore
   * racing a turn's record could persist the turn's read over the restore's
   * write and lose it on disk while both remembered succeeding.
   */
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
      // No file yet is a session without checkpoints, distinct from a failed
      // read: throws stay failures, only ENOENT is a clean empty answer.
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    try {
      return readStored(raw, sessionId);
    } catch (error) {
      // Malformed bytes are kept for the user rather than being overwritten
      // by the next record.
      const backup = `${filePath}.corrupt-${Date.now()}`;
      await fsPromises.rename(filePath, backup).catch(() => {});
      console.warn(`[checkpoints] store file for ${sessionId} was unreadable and was moved to ${backup}`);
      throw error;
    }
  };

  const persist = async (sessionId, entries) => {
    const payload = JSON.stringify({ version: 1, list: entries });
    await fsPromises.mkdir(storeDirectory, { recursive: true });
    // Temp file in the same directory so the rename is atomic on one device.
    const tmpPath = `${filePathOf(sessionId)}.${process.pid}.tmp`;
    await fsPromises.writeFile(tmpPath, payload, 'utf8');
    await fsPromises.rename(tmpPath, filePathOf(sessionId));
  };

  return {
    /** Entries of one session, newest first; throws on a failed or malformed read. */
    list: (sessionId) => readFile(sessionId),

    /**
     * One entry by checkpoint id, or null. A missing file is a session without
     * checkpoints; a malformed file never masquerades as an empty registry.
     */
    get: async (sessionId, checkpointId) => {
      const entries = await readFile(sessionId);
      return entries.find((entry) => entry.id === checkpointId) ?? null;
    },

    /**
     * Records the checkpoint of one turn, newest first, bounded. A turn that
     * continues (retried, resumed) replaces its own entry instead of stacking
     * a second one for the same user message. Everything the new list drops
     * goes to `onEvicted` while its refs are still pinned, so the runtime can
     * unpin them; the entry itself is the caller's, fields normalized here.
     */
    record: (sessionId, input) => runExclusive(async () => {
      const entry = readEntry({ ...input, restored: null });
      if (!entry) throw new Error('Checkpoint entry is malformed');
      const files = entry.files.slice(0, FILE_LIMIT);
      const stored = { ...entry, files, truncated: entry.files.length > files.length };
      const current = await readFile(sessionId);
      const kept = current.filter((existing) => existing.userMessageID !== stored.userMessageID);
      const replaced = current.filter((existing) => existing.userMessageID === stored.userMessageID);
      const next = [stored, ...kept].slice(0, LIST_LIMIT);
      const overflow = [stored, ...kept].slice(LIST_LIMIT);
      if (replaced.length || overflow.length) {
        await Promise.resolve(onEvicted([...replaced, ...overflow])).catch(() => {});
      }
      await persist(sessionId, next);
      return stored;
    }),

    /**
     * Replaces a checkpoint's restore state. `restored` is null (reset) or
     * the fresh undo snapshot; it replaces whatever was there. Returns the
     * previous entry so the caller can unpin a superseded undo ref, or null
     * when the checkpoint is gone.
     */
    markRestored: (sessionId, checkpointId, restored) => runExclusive(async () => {
      const entries = await readFile(sessionId);
      const previous = entries.find((entry) => entry.id === checkpointId) ?? null;
      if (!previous) return null;
      const next = entries.map((entry) => (entry.id === checkpointId ? { ...entry, restored } : entry));
      await persist(sessionId, next);
      return previous;
    }),
  };
};
