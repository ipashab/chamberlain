// A run that starts outside the debug surface — a chat request that launches
// one through the debugger API — still has to meet its user. When a run
// appears, the debug surface joins the layout: below the region that shows
// the run's file, the way the PyCharm editor sits above its debugger; beside
// nothing, it opens the way the rail opens it.

import React from 'react';

import { CHAT_NODE, leavesOf } from '@/lib/workspace/layoutTree';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { useUIStore, type ContextPanelTab } from '@/stores/useUIStore';
import { debuggerApi } from '@/lib/debugger/debugger-api';

/**
 * The leaf that should keep its side of the debug surface's split: the one
 * showing the most recently touched placed tab — the file a chat request
 * just opened for the run.
 */
const neighborLeafId = (tabs: readonly ContextPanelTab[], leaves: ReturnType<typeof leavesOf>): string | null => {
  const leafIdByTabId = new Map(leaves.flatMap((leaf) => leaf.tabs.map((id) => [id, leaf.id] as const)));
  const placed = tabs.filter((tab) => leafIdByTabId.has(tab.id));
  const mostRecent = placed.length > 0
    ? placed.reduce((best, tab) => (tab.touchedAt >= best.touchedAt ? tab : best))
    : null;
  return mostRecent != null ? leafIdByTabId.get(mostRecent.id) ?? null : null;
};

/**
 * Reveals the debug surface for the project's layout. Idempotent: a second
 * call only re-activates what an earlier one already placed.
 */
export const revealDebugSurface = (directoryKey: string): void => {
  const store = useUIStore.getState();
  const panel = store.contextPanelByDirectory[directoryKey];
  const tabs = panel?.tabs ?? [];
  const leaves = leavesOf(panel?.layout ?? CHAT_NODE);

  const debugTabIds = new Set(tabs.filter((tab) => tab.mode === 'debug').map((tab) => tab.id));
  const showing = leaves.find((leaf) => leaf.tabs.some((id) => debugTabIds.has(id)));
  const fromLeafId = showing != null ? null : neighborLeafId(tabs, leaves);
  const targetLeafId = showing != null
    ? showing.id
    : fromLeafId != null
      ? store.splitLayoutRegion(directoryKey, { leafId: fromLeafId }, 'column', 0.5)
      : null;

  if (targetLeafId != null) {
    // Looking the surface up in that leaf activates it: it moves any debug
    // tab already in the strip, or opens a fresh one straight into it.
    store.openContextSurfaceInLeaf(directoryKey, 'debug', targetLeafId);
  }
  // The open reveals the zone. After the placement above it is a no-op move:
  // the leaf already showing the debug tab keeps it.
  store.openContextPanelTab(directoryKey, { mode: 'debug' });
};

/**
 * Watches the debugger's state broadcast and reveals the debug surface for
 * every run that starts while mounted. A run that ends and starts again
 * counts as new; a state refresh mid-run does not.
 */
export const useDebuggerSurfaceReveal = (directoryKey: string): void => {
  React.useEffect(() => {
    if (!directoryKey) {
      return;
    }
    let cancelled = false;
    let lastStartedAt: number | null = null;
    const check = () => {
      debuggerApi.state().then((next) => {
        if (cancelled) return;
        const startedAt = next.session?.launch.startedAt ?? null;
        const previous = lastStartedAt;
        lastStartedAt = startedAt;
        if (startedAt != null && startedAt !== previous) {
          revealDebugSurface(directoryKey);
        }
      }).catch(() => {
        // A server without the debugger leaves the panel layout alone.
      });
    };
    check();
    const unsubscribe = subscribeOpenchamberEvents((event) => {
      if (event.type === 'debugger-changed') check();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [directoryKey]);
};
