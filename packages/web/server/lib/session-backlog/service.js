import { asNonEmptyString, isString } from '../shared/guards.js';
import { backlogDrainBounds } from './tools.js';

/**
 * Session backlog: staged follow-ups for one dialog, and the drain that
 * runs them.
 *
 * The backlog is the session's own queue of prompts the user staged without
 * sending — "here is what comes next, but not yet". The store is the
 * authority on what is staged (per-session JSON, oldest first), and this
 * service is the single executor over it: the routes, the `openchamber_backlog`
 * tool, and the drain all pass through the same writes.
 *
 * The drain is watched, not assumed. It first waits for the session's own
 * current turn to end — a drain started from a tool call runs inside that
 * very turn — then hands each staged item to the session as its own user
 * message and waits for the turn it started, by records, never by clock
 * times: a turn is finished when a new `idle` record stands beyond the one
 * that was newest when the item was sent. An item whose turn never reported
 * an end inside the window, or a prompt that did not reach the session,
 * stops the drain there — the rest of the queue stays staged and the report
 * says exactly that.
 */

class BacklogError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'BacklogError';
    this.statusCode = statusCode;
  }
}

const delay = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

export const createBacklogService = (dependencies) => {
  const {
    store,
    sessionService,
    resolveSessionDirectory,
    getSessionState,
    createOpenCodeClient,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    broadcastUiEvent = () => {},
    now = Date.now,
  } = dependencies;

  if (!store?.add || !store?.list) {
    throw new Error('backlog service needs a store');
  }
  if (!sessionService?.send) {
    throw new Error('backlog service needs a session service with send()');
  }

  const clientFor = (directory) => createOpenCodeClient({
    baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''),
    headers: getOpenCodeAuthHeaders(),
    directory,
  });

  const announce = (sessionID, count, draining) => {
    broadcastUiEvent({ type: 'openchamber:session-backlog', properties: { sessionID, count, draining } });
  };

  const readItems = async (sessionID) => {
    try {
      return await store.list(sessionID);
    } catch (error) {
      throw new BacklogError('The backlog for this session could not be read', 500);
    }
  };

  const waitWhileBusy = async (sessionID, windowMs) => {
    const deadline = now() + windowMs;
    for (;;) {
      const state = getSessionState(sessionID);
      const busy = state?.status === 'busy' || state?.status === 'retry';
      if (!busy) return true;
      if (now() >= deadline) return false;
      await delay(backlogDrainBounds.pollIntervalMs);
    }
  };

  /**
   * The newest `idle` record id at this moment, or null when the session
   * reported none. The baseline the drain's per-item wait compares against.
   */
  const latestIdleRecordID = async (client, sessionID) => {
    let page;
    try {
      page = await client.message.list({
        sessionID,
        limit: backlogDrainBounds.answerPage,
        order: 'desc',
      });
    } catch {
      return null;
    }
    const rows = Array.isArray(page?.data) ? page.data : [];
    for (const row of rows) {
      if (row?.type === 'idle' && asNonEmptyString(row?.id)) return row.id;
    }
    return null;
  };

  /**
   * A turn is finished when a new `idle` record stands beyond the baseline —
   * record ids, never clock times, so a remote OpenCode with a skewed clock
   * still matches. The baseline is read right before the send, never taken
   * from the send's own answer, so even a session with no `idle` records yet
   * is judged honestly.
   */
  const waitTurnEnd = async (client, sessionID, baselineIdleRecordID, windowMs) => {
    const deadline = now() + windowMs;
    for (;;) {
      const page = await client.message.list({
        sessionID,
        limit: backlogDrainBounds.answerPage,
        order: 'desc',
      }).catch(() => null);
      const rows = Array.isArray(page?.data) ? page.data : [];
      // Newest first: the baseline `idle` row is the boundary — rows before
      // it are the turn's own records, rows after it are the copied history,
      // and an older `idle` from before the baseline must never count as the
      // turn's end. A null baseline means the window held no `idle` rows at
      // all, so every `idle` row it now holds is the turn's own.
      let finished = null;
      for (const row of rows) {
        const id = asNonEmptyString(row?.id);
        if (!id) continue;
        if (baselineIdleRecordID != null && id === baselineIdleRecordID) {
          finished = false;
          break;
        }
        if (row?.type === 'idle') {
          finished = true;
          break;
        }
      }
      if (finished === true) return true;
      if (now() >= deadline) return false;
      await delay(backlogDrainBounds.pollIntervalMs);
    }
  };

  /**
   * @type {Map<string, boolean>} sessionID -> a drain is running. The map is
   * the session's honest answer about its own drain, and it dies with the
   * process: the queue itself is on disk, so a restarted server drains again.
   */
  const draining = new Map();

  const drain = async (sessionID, directory) => {
    const endedQuietly = () => {
      draining.delete(sessionID);
      announce(sessionID, null, false);
    };
    const client = clientFor(directory);
    // The caller's own turn first: a drain started from a tool call runs
    // inside that turn, and the first item must not queue behind it.
    const idle = await waitWhileBusy(sessionID, backlogDrainBounds.firstIdleWindowMs);
    if (!idle) {
      endedQuietly();
      return;
    }
    for (;;) {
      let items;
      try {
        items = await store.list(sessionID);
      } catch (error) {
        endedQuietly();
        return;
      }
      if (items.length === 0) break;
      const item = items[0];
      const baseline = await latestIdleRecordID(client, sessionID);
      let sent;
      try {
        sent = await sessionService.send(sessionID, { prompt: item.text, directory });
      } catch (error) {
        console.warn('[backlog] drain stopped: the item could not be sent:', error?.message ?? error);
        endedQuietly();
        return;
      }
      if (asNonEmptyString(sent?.promptError) || sent?.promptDispatched === false) {
        console.warn('[backlog] drain stopped: the session would not take the item:', sent?.promptError ?? 'prompt not dispatched');
        endedQuietly();
        return;
      }
      const done = await waitTurnEnd(client, sessionID, baseline, backlogDrainBounds.itemRunWindowMs);
      if (!done) {
        console.warn('[backlog] drain stopped: the item\'s turn did not end inside the window');
        endedQuietly();
        return;
      }
      try {
        await store.remove(sessionID, item.id);
      } catch (error) {
        console.warn('[backlog] drain cannot remove the finished item:', error?.message ?? error);
        endedQuietly();
        return;
      }
      announce(sessionID, items.length - 1, true);
    }
    endedQuietly();
  };

  const requireSession = (sessionID) => {
    const id = asNonEmptyString(sessionID);
    if (!id) throw new BacklogError('sessionID is required', 400);
    return id;
  };

  const listAction = async (input) => {
    const sessionID = requireSession(input?.sessionID ?? input?.callerSessionID);
    return { sessionID, items: await readItems(sessionID), draining: draining.get(sessionID) === true };
  };

  const addAction = async (input) => {
    const sessionID = requireSession(input?.sessionID ?? input?.callerSessionID);
    try {
      const item = await store.add(sessionID, { text: input?.text, createdAt: now() });
      announce(sessionID, null, draining.get(sessionID) === true);
      return { sessionID, item };
    } catch (error) {
      throw new BacklogError(error instanceof Error ? error.message : String(error), 400);
    }
  };

  const removeAction = async (input) => {
    const sessionID = requireSession(input?.sessionID ?? input?.callerSessionID);
    const itemID = asNonEmptyString(input?.itemID);
    if (!itemID) throw new BacklogError('itemID is required, as backlog.list shows it', 400);
    const removed = await store.remove(sessionID, itemID);
    announce(sessionID, null, draining.get(sessionID) === true);
    return { sessionID, itemID, removed };
  };

  const moveAction = async (input) => {
    const sessionID = requireSession(input?.sessionID ?? input?.callerSessionID);
    const itemID = asNonEmptyString(input?.itemID);
    if (!itemID) throw new BacklogError('itemID is required, as backlog.list shows it', 400);
    const position = input?.position;
    if (!Number.isSafeInteger(position) || position < 0) {
      throw new BacklogError('position is required, the target index in the queue, 0 first', 400);
    }
    let items;
    try {
      items = await store.move(sessionID, itemID, position);
    } catch (error) {
      throw new BacklogError(error instanceof Error ? error.message : String(error), 400);
    }
    if (!items) {
      throw new BacklogError(`No staged item ${itemID} is queued in this session`, 404);
    }
    announce(sessionID, null, draining.get(sessionID) === true);
    return { sessionID, itemID, position, items };
  };

  const clearAction = async (input) => {
    const sessionID = requireSession(input?.sessionID ?? input?.callerSessionID);
    const removed = await store.clear(sessionID);
    announce(sessionID, 0, draining.get(sessionID) === true);
    return { sessionID, removed };
  };

  const runAction = async (input) => {
    const sessionID = requireSession(input?.sessionID ?? input?.callerSessionID);
    const items = await readItems(sessionID);
    if (draining.get(sessionID) === true) {
      throw new BacklogError('The backlog of this session is already draining', 409);
    }
    if (items.length === 0) {
      throw new BacklogError('The backlog of this session is empty', 409);
    }
    let directory = null;
    try {
      directory = await resolveSessionDirectory(sessionID);
    } catch (error) {
      throw new BacklogError(`This session's directory could not be resolved: ${error instanceof Error ? error.message : String(error)}`, 500);
    }
    if (!isString(directory) || !directory.trim()) {
      throw new BacklogError('This session has no directory to drain the backlog into', 500);
    }
    draining.set(sessionID, true);
    announce(sessionID, items.length, true);
    void drain(sessionID, directory).catch((error) => {
      console.warn('[backlog] drain failed:', error?.message ?? error);
    });
    return {
      sessionID,
      started: true,
      staged: items.length,
      note: 'Each staged item runs as its own turn, in order; watch the backlog and this dialog',
    };
  };

  return {
    executeAction: async (action, input = {}) => {
      switch (action) {
        case 'backlog.list':
          return listAction(input);
        case 'backlog.add':
          return addAction(input);
        case 'backlog.remove':
          return removeAction(input);
        case 'backlog.move':
          return moveAction(input);
        case 'backlog.clear':
          return clearAction(input);
        case 'backlog.run':
          return runAction(input);
        default:
          throw new BacklogError(`Unknown backlog action: ${action || 'missing'}`, 400);
      }
    },
  };
};
