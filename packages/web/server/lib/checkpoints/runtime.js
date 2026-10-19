import fs from 'fs';
import path from 'path';
import { OpenCode } from '@opencode/client';
import { asNonEmptyString, isRecord, isString } from '../shared/guards.js';
import { readMergedSettingsSync } from '../opencode/settings-files.js';
import { collectTurnFiles } from './records.js';

// Per-turn checkpoints: the runtime arms a whole-worktree snapshot when a
// session turns busy and, when the turn ends having touched files, records the
// turn as a checkpoint of that pre-turn state. Restores answer through the
// same module and are undoable: every restore captures the state it displaced
// first, so it can be put back. The snapshot and restore mechanics live in
// `../git/service.js` (`captureWorktreeSnapshot`, `restoreSnapshotFiles`),
// the registry in `./store.js`.
//
// Scope and races, kept honest: the snapshot is taken at the moment the turn
// starts, so restoring returns exactly the worktree as it stood then, with no
// way to separate one session's mid-flight changes from another's when two
// sessions edit one directory. A restore is not a git revert: it overwrites
// the files the turn touched, including later edits to those files, and the
// undo ref is what makes that survivable. The conversation itself is never
// rewound: that is the timeline's job.

const OPENCHAMBER_SETTINGS_FILE = process.env.OPENCHAMBER_SETTINGS_FILE || '';
const FETCH_TIMEOUT_MS = 20_000;

const getCheckpointsEnabled = () => {
  const settings = readMergedSettingsSync({ fs, path, settingsFilePath: OPENCHAMBER_SETTINGS_FILE });
  return settings.sessionCheckpointsEnabled !== false;
};

const CHECKPOINTS_BASE_REF_SEGMENT = 'base';

// Each observing runtime keeps its own copy of these two readers (the event
// hub translates wire events once; the consumers were written against that
// vocabulary and stay unaware of the wire shape).
const extractSessionStatus = (payload) => {
  if (!isRecord(payload) || payload.type !== 'session.status') return null;
  const properties = isRecord(payload.properties) ? payload.properties : {};
  const status = isRecord(properties.status) ? properties.status : {};
  const info = isRecord(properties.info) ? properties.info : {};
  const sessionId = asNonEmptyString(properties.sessionID);
  const type = asNonEmptyString(status.type) ?? asNonEmptyString(info.type);
  if (!sessionId || !type) return null;
  return {
    sessionId,
    type,
    directory: asNonEmptyString(properties.directory) ?? asNonEmptyString(info.directory) ?? '',
  };
};

const extractUserMessage = (payload) => {
  if (!isRecord(payload) || payload.type !== 'message.updated') return null;
  const info = payload.properties?.info;
  if (!isRecord(info) || info.role !== 'user') return null;
  const sessionId = asNonEmptyString(info.sessionID);
  if (!sessionId) return null;
  const created = Number.isFinite(info.time?.created) ? info.time.created : 0;
  return { sessionId, createdAt: created };
};

/**
 * @param {object} options
 * @param {(value: string, route?: string) => string} options.buildOpenCodeUrl
 * @param {() => object} options.getOpenCodeAuthHeaders
 * @param {ReturnType<typeof import('./store.js').createCheckpointStore>} options.store
 * @param {object} options.git `../git/service.js` snapshot and restore functions, injectable for tests.
 * @param {(sessionID: string) => boolean | Promise<boolean>} [options.isSessionArchived]
 * @param {(event: object) => void} [options.broadcast] UI event once a checkpoint is recorded.
 * @param {() => boolean} [options.getEnabled]
 * @param {() => number} [options.now]
 */
export const createCheckpointsRuntime = ({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  store,
  git,
  isSessionArchived = async () => false,
  broadcast = null,
  getEnabled = getCheckpointsEnabled,
  now = Date.now,
}) => {
  /**
   * The snapshot armed for the turn in flight: `ref` pins the pre-turn tree,
   * `directory` is where it was captured, and a superseded or unconsumed
   * capture is always unpinned on its way out, because a pinned ref survives
   * `git gc` forever.
   */
  const armed = new Map();
  const runs = new Map();
  const warnedDirectories = new Set();
  let stopped = false;
  let parkedNoticeLogged = false;
  let unarmedNoticeLogged = false;

  const refNameOf = (sessionId, at, suffix) => (
    `refs/openchamber/checkpoints/${sessionId}/${at}/${suffix}`
  );

  const warnOncePerDirectory = (directory, error) => {
    if (warnedDirectories.has(directory)) return;
    warnedDirectories.add(directory);
    console.warn('[checkpoints] cannot snapshot this directory, turns here stay without checkpoints:', directory);
    if (error) console.warn('[checkpoints] snapshot failure:', error?.message ?? error);
  };

  const unpin = (directory, refName) => {
    if (!directory || !refName) return;
    Promise.resolve(git.deleteCheckpointRef(directory, refName))
      .catch(() => console.warn('[checkpoints] could not drop a pinned snapshot ref:', refName));
  };

  const dropArmed = (sessionId, { unpinRef = true } = {}) => {
    const entry = armed.get(sessionId);
    armed.delete(sessionId);
    if (entry && unpinRef) {
      entry.ref.then((settled) => {
        if (settled.ok) unpin(settled.snapshot?.directory, settled.snapshot?.refName);
      });
    }
    return entry;
  };

  const arm = (sessionId, directory) => {
    if (!directory) return;
    // A busy while the previous turn is still busy is a re-ask or a retry: the
    // previous pre-turn state no longer precedes any turn, so it is unpinned.
    dropArmed(sessionId);
    const at = now();
    const refName = refNameOf(sessionId, at, CHECKPOINTS_BASE_REF_SEGMENT);
    const ref = Promise.resolve()
      .then(async () => {
        const snapshot = await git.captureWorktreeSnapshot(directory, { refName });
        return { directory, ...snapshot };
      });
    // Rejection is consumed here once, the turn end reads the settled state.
    const settled = ref.then(
      (snapshot) => ({ ok: true, snapshot }),
      (error) => ({ ok: false, error }),
    );
    armed.set(sessionId, { at, directory, ref: settled });
  };

  const runTurnEnd = (sessionId, directoryHint) => {
    const previous = runs.get(sessionId);
    previous?.controller.abort();
    const controller = new AbortController();
    const run = { controller, armedAt: now() };
    runs.set(sessionId, run);
    Promise.resolve()
      .then(() => recordTurn(sessionId, directoryHint, controller.signal))
      .catch((error) => {
        if (!controller.signal.aborted && !stopped) {
          console.warn('[checkpoints] turn capture failed:', error?.message ?? error);
        }
      })
      .finally(() => {
        if (runs.get(sessionId) === run) runs.delete(sessionId);
      });
  };

  const recordTurn = async (sessionId, directoryHint, signal) => {
    if (!getEnabled()) return;
    const armedEntry = armed.get(sessionId);
    if (!armedEntry) {
      // First turn after a restart, or arming was off: nothing pre-turn to
      // restore to, and the turn's own snapshot will serve the next one.
      if (!unarmedNoticeLogged) {
        unarmedNoticeLogged = true;
        console.log('[checkpoints] a turn ended without an armed pre-turn snapshot; it is not checkpointed');
      }
      return;
    }
    const baseUrl = buildOpenCodeUrl('/', '').replace(/\/$/, '');
    const openCodeDirectory = armedEntry.directory || directoryHint;
    // v2 scopes by header and rejects non-ASCII header values.
    const headers = { ...getOpenCodeAuthHeaders() };
    if (openCodeDirectory) headers['x-opencode-directory'] = encodeURIComponent(openCodeDirectory);
    const client = OpenCode.make({ baseUrl, headers });
    const requestOptions = () => ({ signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]) });
    signal.throwIfAborted();

    // An archived session is put away: no checkpoint of the next turn, and
    // the armed ref is no one's.
    if (await isSessionArchived(sessionId)) {
      dropArmed(sessionId);
      return;
    }

    const turn = await collectTurnFiles({
      signal,
      readPage: ({ limit, cursor }) => client.message.list(
        { sessionID: sessionId, limit, ...(cursor ? { cursor } : { order: 'desc' }) },
        requestOptions(),
      ),
    });
    signal.throwIfAborted();

    const settled = await armedEntry.ref;
    if (!settled.ok) {
      dropArmed(sessionId, { unpinRef: false });
      warnOncePerDirectory(armedEntry.directory, settled.error);
      return;
    }
    if (!turn) {
      // The turn changed no files: the armed ref has nothing to answer for.
      dropArmed(sessionId);
      return;
    }
    const snapshot = settled.snapshot;
    try {
      await store.record(sessionId, {
        id: turn.userMessageID,
        userMessageID: turn.userMessageID,
        directory: snapshot.directory,
        tree: snapshot.tree,
        baseRefName: snapshot.refName,
        createdAt: now(),
        files: turn.files,
      });
    } catch (error) {
      // The entry never reached the registry, so its ref is no one's.
      unpin(snapshot.directory, snapshot.refName);
      throw error;
    }
    armed.delete(sessionId);
    broadcast?.({
      type: 'openchamber:session-checkpoints',
      properties: { sessionID: sessionId },
    });
  };

  const processPayload = (payload, directoryHint = '') => {
    if (stopped) return;
    if (!store || !git?.captureWorktreeSnapshot || !git?.restoreSnapshotFiles) {
      if (!parkedNoticeLogged) {
        parkedNoticeLogged = true;
        console.log('[checkpoints] parked: the store or the git snapshot functions are not wired');
      }
      return;
    }
    const status = extractSessionStatus(payload);
    if (status) {
      if (status.type === 'busy') {
        if (getEnabled()) arm(status.sessionId, status.directory || directoryHint);
        return;
      }
      if (status.type === 'idle') {
        runTurnEnd(status.sessionId, status.directory || directoryHint);
        return;
      }
      return;
    }
    const userMessage = extractUserMessage(payload);
    if (userMessage) {
      // A newer ask while the previous turn's capture is still running retires
      // it wholesale: its findings would describe the older turn, and its
      // armed ref no longer precedes any turn that will run.
      const run = runs.get(userMessage.sessionId);
      if (run && userMessage.createdAt >= run.armedAt) run.controller.abort();
      const armedEntry = armed.get(userMessage.sessionId);
      if (armedEntry && userMessage.createdAt >= armedEntry.at) dropArmed(userMessage.sessionId);
    }
  };

  /**
   * Registry for a client, newest first. A failed read answers as a failure;
   * an unknown session is simply a session without checkpoints.
   */
  const list = (sessionId) => store.list(sessionId);

  const readEntryOrFailure = async (sessionId, checkpointId) => {
    if (!asNonEmptyString(sessionId) || !asNonEmptyString(checkpointId)) {
      return { ok: false, statusCode: 400, message: 'Session and checkpoint are required' };
    }
    let entry;
    try {
      entry = await store.get(sessionId, checkpointId);
    } catch (error) {
      return { ok: false, statusCode: 500, message: 'The checkpoint registry could not be read' };
    }
    if (!entry) return { ok: false, statusCode: 404, message: 'No such checkpoint for this session' };
    return { ok: true, entry };
  };

  /**
   * Restores files to the checkpoint's pre-turn state (`undo: false`) or puts
   * back what the last restore displaced (`undo: true`). Both capture the
   * state they overwrite, so the action stays reversible; the captured state
   * answers a second undo toggle. Failure grades: 400 usage, 404 unknown
   * checkpoint, 409 the repository cannot serve the snapshot, 500 the
   * registry could not be read.
   */
  const restore = async (sessionId, checkpointId, { undo = false } = {}) => {
    const read = await readEntryOrFailure(sessionId, checkpointId);
    if (!read.ok) return read;
    const entry = read.entry;
    const targetTree = undo ? entry.restored?.tree : entry.tree;
    if (!targetTree) {
      return { ok: false, statusCode: 400, message: 'Nothing to undo yet: this checkpoint was never restored' };
    }
    let current;
    try {
      // One undo ref per checkpoint, overwritten on each toggle: it always
      // holds the state the last action displaced.
      const undoRefName = entry.baseRefName.replace(/\/base$/, '/undo');
      current = await git.captureWorktreeSnapshot(entry.directory, { refName: undoRefName });
    } catch (error) {
      return { ok: false, statusCode: 409, message: 'The checkpointed repository cannot be reached' };
    }
    let outcome;
    try {
      outcome = await git.restoreSnapshotFiles(entry.directory, targetTree, entry.files);
    } catch (error) {
      // The undo ref stays pinned: it is the state the failed restore meant to
      // displace, and marking the checkpoint restored would claim files that
      // never moved.
      unpin(current.directory, current.refName);
      return { ok: false, statusCode: 500, message: 'Restoring the checkpoint failed' };
    }
    const previousRestored = entry.restored;
    try {
      await store.markRestored(sessionId, checkpointId, { at: now(), tree: current.tree, refName: current.refName });
    } catch (error) {
      unpin(current.directory, current.refName);
      return { ok: false, statusCode: 500, message: 'The checkpoint registry could not be written' };
    }
    if (previousRestored && previousRestored.refName !== current.refName) {
      unpin(entry.directory, previousRestored.refName);
    }
    return { ok: true, checkpoint: checkpointId, ...outcome };
  };

  const stop = () => {
    stopped = true;
    for (const { controller } of runs.values()) controller.abort();
    runs.clear();
    for (const sessionId of Array.from(armed.keys())) dropArmed(sessionId);
  };

  return { processPayload, list, restore, stop };
};
