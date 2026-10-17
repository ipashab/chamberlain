// Folder group presets: which agent a folder's sessions start on. One table
// keyed by folder id, hydrated from the server route and written through on
// every change. See groupPresetsApi.ts for the contract.

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

import {
  DEFAULT_GROUP_APPLY_RULE,
  normalizeGroupPreset,
  fetchGroupPresetSnapshot,
  saveGroupPresetSnapshot,
  type GroupApplyRule,
  type GroupPreset,
  type GroupPresetSnapshot,
} from '@/lib/session-groups/groupPresetsApi';

interface SessionGroupPresetsState {
  presets: Record<string, GroupPreset>;
  loaded: boolean;
  loadError: string | null;
}

interface SessionGroupPresetsActions {
  hydrate: () => Promise<void>;
  getFolderPreset: (folderId: string) => GroupPreset | null;
  setFolderPreset: (folderId: string, defaultAgent: string | null, applyRule?: GroupApplyRule) => void;
  clearFolderPreset: (folderId: string) => void;
  clearFolders: (folderIds: string[]) => void;
}

type SessionGroupPresetsStore = SessionGroupPresetsState & SessionGroupPresetsActions;

let saveGeneration = 0;

// Folder ids a delete named but the server has not confirmed yet; they ride
// along with the next write, because the server-side merge would resurrect
// them otherwise — the same inbox session folders keep for deletions.
const pendingRemoved = new Set<string>();

export const useSessionGroupPresetsStore = create<SessionGroupPresetsStore>()(
  devtools((set, get) => ({
    presets: {},
    loaded: false,
    loadError: null,

    hydrate: async () => {
      try {
        const snapshot = await fetchGroupPresetSnapshot();
        const presets: Record<string, GroupPreset> = {};
        for (const [folderId, preset] of Object.entries(snapshot.presets)) {
          presets[folderId] = normalizeGroupPreset(preset);
        }
        set({ presets, loaded: true, loadError: null });
      } catch (error) {
        // A failed read is not "no presets": keep the table empty and mark
        // the error, so the UI stays inert instead of firing preset logic
        // on a guess.
        set({ loaded: false, loadError: error instanceof Error ? error.message : 'Group presets could not load' });
      }
    },

    getFolderPreset: (folderId) => {
      const preset = get().presets[folderId];
      // A preset with no agent does nothing: keep it out of the callers' way.
      if (preset?.defaultAgent) return preset;
      return null;
    },

    setFolderPreset: (folderId, defaultAgent, applyRule) => {
      const current = get().presets;
      const rule = applyRule ?? get().presets[folderId]?.applyRule ?? DEFAULT_GROUP_APPLY_RULE;
      const next = {
        ...current,
        [folderId]: normalizeGroupPreset({ folderId, defaultAgent, applyRule: rule }),
      };
      // Writing a folder withdraws any delete that is still in flight for it.
      pendingRemoved.delete(folderId);
      set({ presets: next });
      void writeThrough(next);
    },

    clearFolderPreset: (folderId) => {
      const current = { ...get().presets };
      if (!(folderId in current)) return;
      delete current[folderId];
      pendingRemoved.add(folderId);
      set({ presets: current });
      void writeThrough(current);
    },

    clearFolders: (folderIds) => {
      if (folderIds.length === 0) return;
      const idSet = new Set(folderIds);
      const current = get().presets;
      if (!folderIds.some((folderId) => folderId in current)) return;
      const next: Record<string, GroupPreset> = {};
      for (const [folderId, preset] of Object.entries(current)) {
        if (!idSet.has(folderId)) next[folderId] = preset;
      }
      for (const folderId of folderIds) {
        if (idSet.has(folderId) && folderId in current) pendingRemoved.add(folderId);
      }
      set({ presets: next });
      void writeThrough(next);
    },
  })),
);

/** Writes the whole table plus any deletes still awaiting confirmation. */
const writeThrough = (presets: Record<string, GroupPreset>) => {
  const generation = ++saveGeneration;
  const removed = [...pendingRemoved];
  const snapshot: GroupPresetSnapshot & { removed?: string[] } = { version: 1, presets };
  if (removed.length > 0) snapshot.removed = removed;
  void saveGroupPresetSnapshot(snapshot)
    .then(() => {
      // The server took the deletes; the inbox can forget them — but only
      // if no newer change is already in flight.
      if (generation !== saveGeneration) return;
      for (const folderId of removed) pendingRemoved.delete(folderId);
    })
    .catch((error) => {
      // A newer change superseded this write, or the server state moved on;
      // keep the deletes pending for the next write and rehydrate so the
      // table reflects what the server really holds.
      if (generation !== saveGeneration) return;
      console.error('[session-group-presets] save failed', error);
      void useSessionGroupPresetsStore.getState().hydrate();
    });
};

// Hydrate once when the UI first runs, the way the session-folders store
// does: the sidebar reads presets on its first render, so waiting for a mount
// would let a "new chat in folder" fire before the table has loaded and start
// the session on the wrong agent.
void useSessionGroupPresetsStore.getState().hydrate();
