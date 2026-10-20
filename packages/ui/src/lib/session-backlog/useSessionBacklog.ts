// One fetch of a session's backlog shared by every surface that shows it.
// The cache lives at module level so the composer strip pays for one fetch;
// the server's `openchamber:session-backlog` frames invalidate exactly the
// session they name — an item staged in another window, or a drain taking its
// next item, is honest here without the strip polling.

import { useCallback, useEffect, useState } from 'react';

import { type BacklogItem, backlogApi } from './backlogApi';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';

type CacheSlot = {
  items: BacklogItem[];
  draining: boolean;
  /** False until the first fetch answered; a failed fetch keeps `loaded` false so an empty strip never reads as an authoritative empty queue. */
  loaded: boolean;
  inflight: Promise<void> | null;
};

const cache = new Map<string, CacheSlot>();
const listeners = new Map<string, Set<() => void>>();
/** One global event subscription while at least one surface listens, so surfaces never stack subscriptions. */
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
      if (event.type === 'session-backlog') {
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
  const slot = cache.get(sessionId) ?? { items: [], draining: false, loaded: false, inflight: null };
  cache.set(sessionId, slot);
  if (slot.inflight && !force) return slot.inflight;
  if (slot.loaded && !force) return Promise.resolve();
  slot.inflight = backlogApi.list(sessionId)
    .then(({ items, draining }) => {
      slot.items = items;
      slot.draining = draining;
      slot.loaded = true;
    })
    .catch(() => {
      // A failed fetch must not masquerade as an authoritative empty
      // backlog: the previous items stay and `loaded` stays false.
      slot.loaded = false;
    })
    .finally(() => {
      slot.inflight = null;
      emit(sessionId);
    });
  return slot.inflight;
};

/**
 * The session's staged backlog for the strip that renders it. The first mount
 * fetches when the session is known, later mounts share the cache, and every
 * staged, removed or drained item is followed by a forced refetch through the
 * broadcast, so two windows never disagree about what is queued.
 */
export const useSessionBacklog = (sessionId: string | null) => {
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

  const remove = useCallback(async (itemId: string) => {
    if (!sessionId) return false;
    const removed = await backlogApi.remove(sessionId, itemId);
    void fetchSession(sessionId, { force: true });
    return removed;
  }, [sessionId]);

  const move = useCallback(async (itemId: string, position: number) => {
    if (!sessionId) return null;
    const items = await backlogApi.move(sessionId, itemId, position);
    void fetchSession(sessionId, { force: true });
    return items;
  }, [sessionId]);

  const clear = useCallback(async () => {
    if (!sessionId) return 0;
    const removed = await backlogApi.clear(sessionId);
    void fetchSession(sessionId, { force: true });
    return removed;
  }, [sessionId]);

  const run = useCallback(async () => {
    if (!sessionId) return null;
    const outcome = await backlogApi.run(sessionId);
    void fetchSession(sessionId, { force: true });
    return outcome;
  }, [sessionId]);

  const slot = sessionId ? cache.get(sessionId) : undefined;
  return {
    items: slot?.items ?? [],
    draining: slot?.draining ?? false,
    loaded: slot?.loaded ?? false,
    remove,
    move,
    clear,
    run,
  };
};
