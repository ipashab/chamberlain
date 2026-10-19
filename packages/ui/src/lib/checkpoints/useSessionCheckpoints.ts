// One fetch of a session's checkpoint registry shared by every row that shows
// it. The cache lives at module level so N user-message rows of one chat pay
// for one fetch; the server's `openchamber:session-checkpoints` frames
// invalidate exactly the session they name.

import { useCallback, useEffect, useState } from 'react';

import { type CheckpointEntry, checkpointsApi } from './checkpointsApi';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';

type CacheSlot = {
  entries: CheckpointEntry[];
  /** False until the first fetch answered; a failed fetch keeps `loaded` false so it never reads as an authoritative empty registry. */
  loaded: boolean;
  inflight: Promise<void> | null;
};

const cache = new Map<string, CacheSlot>();
const listeners = new Map<string, Set<() => void>>();
/** One global event subscription while at least one row listens, so rows never stack subscriptions. */
let globalSubscription: (() => void) | null = null;
let globalSubscriptionCount = 0;

const emit = (sessionId: string) => {
  for (const listener of listeners.get(sessionId) ?? []) {
    listener();
  }
};

const ensureGlobalSubscription = () => {
  globalSubscriptionCount += 1;
  if (globalSubscriptionCount === 1) {
    globalSubscription = subscribeOpenchamberEvents((event) => {
      if (event.type === 'session-checkpoints') {
        void fetchSession(event.sessionID, { force: true });
      }
    });
  }
};

const releaseGlobalSubscription = () => {
  globalSubscriptionCount = Math.max(0, globalSubscriptionCount - 1);
  if (globalSubscriptionCount === 0 && globalSubscription) {
    globalSubscription();
    globalSubscription = null;
  }
};

const fetchSession = (sessionId: string, { force = false } = {}) => {
  if (!sessionId) return Promise.resolve();
  const slot = cache.get(sessionId) ?? { entries: [], loaded: false, inflight: null };
  cache.set(sessionId, slot);
  if (slot.inflight && !force) return slot.inflight;
  if (slot.loaded && !force) return Promise.resolve();
  slot.inflight = checkpointsApi.list(sessionId)
    .then((entries) => {
      slot.entries = entries;
      slot.loaded = true;
    })
    .catch(() => {
      // A failed fetch must not masquerade as an authoritative empty
      // registry: the previous entries stay and `loaded` stays false, so
      // rows render no new actions rather than wrong ones.
      slot.loaded = false;
    })
    .finally(() => {
      slot.inflight = null;
      emit(sessionId);
    });
  return slot.inflight;
};

/**
 * The session's checkpoint registry for the rows that render it. The first
 * mount fetches when the session is known, later mounts share the cache, and
 * a restore's outcome is followed by a forced refetch: the server persisted
 * the undo record with the restore, so its registry is the only authority on
 * whether the next click is an undo.
 */
export const useSessionCheckpoints = (sessionId: string) => {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!sessionId) return;
    const listener = () => setTick((tick) => tick + 1);
    const sessionListeners = listeners.get(sessionId) ?? new Set<() => void>();
    sessionListeners.add(listener);
    listeners.set(sessionId, sessionListeners);
    ensureGlobalSubscription();
    void fetchSession(sessionId);
    return () => {
      sessionListeners.delete(listener);
      if (sessionListeners.size === 0) listeners.delete(sessionId);
      releaseGlobalSubscription();
    };
  }, [sessionId]);

  const entryOf = useCallback((userMessageId: string) => {
    return cache.get(sessionId)?.entries.find((entry) => entry.userMessageID === userMessageId) ?? null;
  }, [sessionId]);

  const restore = useCallback(async (checkpointId: string, undo: boolean) => {
    const outcome = await checkpointsApi.restore(sessionId, checkpointId, undo);
    void fetchSession(sessionId, { force: true });
    return outcome;
  }, [sessionId]);

  const slot = cache.get(sessionId);
  return {
    entries: slot?.entries ?? [],
    loaded: slot?.loaded ?? false,
    entryOf,
    restore,
  };
};
