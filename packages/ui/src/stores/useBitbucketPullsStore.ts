import { create } from 'zustand';
import { z } from 'zod';

import { devtools, persist } from 'zustand/middleware';

import type { BitbucketPullView } from '@/lib/bitbucket/pull-view-api';
import { createDeferredSafeJSONStorage } from './utils/safeStorage';

/** The remembered read: enough to draw a row, not a mirror of the pull. */
const recentEntrySchema = z.object({
    url: z.string(),
    number: z.number(),
    title: z.string(),
    state: z.enum(['open', 'merged', 'closed']),
    at: z.number(),
});

type BitbucketPullRecent = z.infer<typeof recentEntrySchema>;

const recentsSchema = z.array(recentEntrySchema);

/** What the persisted blob can be: parsed once at the storage boundary. */
const persistedStateSchema = z.object({ recents: recentsSchema }).nullish();

const RECENTS_CAP = 10;

/**
 * The pull requests the user has opened, most recent first — the dedicated
 * surface's memory between sessions. Only pulls the server actually read
 * land here, and only what a row needs to be recognized again: the URL, the
 * number, the title and the state at read time, a snapshot by construction.
 */
export const useBitbucketPullsStore = create<{
    recents: BitbucketPullRecent[];
    noteRead: (view: BitbucketPullView) => void;
    forget: (url: string) => void;
}>()(
    devtools(
        persist(
            (set) => ({
                recents: [],
                noteRead: (view) => set((state) => {
                    const entry: BitbucketPullRecent = {
                        url: view.pull.url,
                        number: view.pull.number,
                        title: view.pull.title,
                        state: view.pull.state,
                        at: Date.now(),
                    };
                    // First-read order is preserved: the list is capped by
                    // dropping the tail, never the newest read.
                    const rest = state.recents.filter((item) => item.url !== entry.url);
                    return { recents: [entry, ...rest].slice(0, RECENTS_CAP) };
                }),
                forget: (url) => set((state) => ({
                    recents: state.recents.filter((item) => item.url !== url),
                })),
            }),
            {
                name: 'openchamber-bitbucket-pulls',
                version: 1,
                storage: createDeferredSafeJSONStorage(),
                partialize: (state) => ({ recents: state.recents }),
                // Persisted state is just like any other I/O boundary: the
                // rows are never trusted until the shape says they are rows.
                merge: (persisted, current) => {
                    const parsed = persistedStateSchema.safeParse(persisted);
                    return { ...current, recents: parsed.success ? parsed.data?.recents ?? [] : [] };
                },
            },
        ),
        { store: 'bitbucket-pulls' },
    ),
);
