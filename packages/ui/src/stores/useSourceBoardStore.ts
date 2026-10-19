import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { z } from 'zod';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { createDeferredSafeJSONStorage } from './utils/safeStorage';

const SOURCE_BOARD_STORAGE_KEY = 'openchamber.source-board';

/** The board's two lists: the Bitbucket pulls and the Jira issues. */
export type SourceBoardTab = 'pulls' | 'issues';

type SourceBoardChoice = {
  tab: SourceBoardTab;
};

const EMPTY_CHOICE: SourceBoardChoice = { tab: 'pulls' };

type SourceBoardState = {
  /** Keyed by runtime: the choice belongs to one server. */
  choices: Record<string, SourceBoardChoice>;
  update: (patch: Partial<SourceBoardChoice>) => void;
};

const persistedChoices = z.object({
  choices: z.record(z.string(), z.object({
    tab: z.enum(['pulls', 'issues']).catch('pulls'),
  })).catch({}),
});

/**
 * What the board was last left on, so it reopens there. A value an older
 * build saved — a repository tab, a Linear one, a team or a dragged width —
 * reads back as the first tab: the lists it named are not the board's.
 */
export const useSourceBoardStore = create<SourceBoardState>()(
  persist(
    (set) => ({
      choices: {},
      update: (patch) => set((state) => {
        const runtimeKey = getRuntimeKey();
        return { choices: { ...state.choices, [runtimeKey]: { ...(state.choices[runtimeKey] ?? EMPTY_CHOICE), ...patch } } };
      }),
    }),
    {
      name: SOURCE_BOARD_STORAGE_KEY,
      storage: createDeferredSafeJSONStorage(),
      partialize: (state) => ({ choices: state.choices }),
      merge: (persisted, current) => {
        const parsed = persistedChoices.safeParse(persisted);
        return parsed.success
          ? { ...current, choices: parsed.data.choices }
          : { ...current, choices: {} };
      },
    },
  ),
);

export const useSourceBoardChoice = (): SourceBoardChoice => {
  const runtimeKey = getRuntimeKey();
  return useSourceBoardStore((state) => state.choices[runtimeKey] ?? EMPTY_CHOICE);
};
