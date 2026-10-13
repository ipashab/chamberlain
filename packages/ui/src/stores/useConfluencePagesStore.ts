import { create } from 'zustand';
import { z } from 'zod';

import { devtools, persist } from 'zustand/middleware';

import type { ConfluencePageView } from '@/lib/confluence/page-api';
import { createDeferredSafeJSONStorage } from './utils/safeStorage';

/** The remembered read: enough to draw a row, not a mirror of the page. */
const recentEntrySchema = z.object({
    id: z.string(),
    title: z.string(),
    spaceName: z.string().nullish(),
    at: z.number(),
});

type ConfluencePageRecent = z.infer<typeof recentEntrySchema>;

const recentsSchema = z.array(recentEntrySchema);

/** What the persisted blob can be: parsed once at the storage boundary. */
const persistedStateSchema = z.object({ recents: recentsSchema }).nullish();

const RECENTS_CAP = 10;

/**
 * The Confluence pages the user has viewed, most recent first — the
 * surface's memory between sessions. Only pages the server actually read
 * land here, and only what a row needs to be recognized again: the id,
 * the title, the space and the moment of the read, a snapshot by
 * construction.
 */
export const useConfluencePagesStore = create<{
    recents: ConfluencePageRecent[];
    noteRead: (view: ConfluencePageView) => void;
    forget: (id: string) => void;
}>()(
    devtools(
        persist(
            (set) => ({
                recents: [],
                noteRead: (view) => set((state) => {
                    const entry: ConfluencePageRecent = {
                        id: view.id,
                        title: view.title,
                        spaceName: view.space.name ?? view.space.key,
                        at: Date.now(),
                    };
                    // First-read order is preserved: the list is capped by
                    // dropping the tail, never the newest read.
                    const rest = state.recents.filter((item) => item.id !== entry.id);
                    return { recents: [entry, ...rest].slice(0, RECENTS_CAP) };
                }),
                forget: (id) => set((state) => ({
                    recents: state.recents.filter((item) => item.id !== id),
                })),
            }),
            {
                name: 'openchamber-confluence-pages',
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
        { store: 'confluence-pages' },
    ),
);
