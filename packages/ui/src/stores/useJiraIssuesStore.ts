import { create } from 'zustand';
import { z } from 'zod';

import { devtools, persist } from 'zustand/middleware';

import type { JiraIssueView } from '@/lib/jira/issue-view-api';
import { createDeferredSafeJSONStorage } from './utils/safeStorage';

/** The remembered read: enough to draw a row, not a mirror of the issue. */
const recentEntrySchema = z.object({
    ref: z.string(),
    key: z.string(),
    summary: z.string(),
    at: z.number(),
});

type JiraIssueRecent = z.infer<typeof recentEntrySchema>;

const recentsSchema = z.array(recentEntrySchema);

/** What the persisted blob can be: parsed once at the storage boundary. */
const persistedStateSchema = z.object({ recents: recentsSchema }).nullish();

const RECENTS_CAP = 10;

/**
 * The Jira issues the user has viewed, most recent first — the surface's
 * memory between sessions. Only issues the server actually read land
 * here, and only what a row needs to be recognized again: the reference,
 * the key, the summary and the moment of the read, a snapshot by
 * construction.
 */
export const useJiraIssuesStore = create<{
    recents: JiraIssueRecent[];
    noteRead: (view: JiraIssueView) => void;
    forget: (ref: string) => void;
}>()(
    devtools(
        persist(
            (set) => ({
                recents: [],
                noteRead: (view) => set((state) => {
                    const entry: JiraIssueRecent = {
                        ref: view.issue.url,
                        key: view.issue.key,
                        summary: view.issue.summary,
                        at: Date.now(),
                    };
                    // First-read order is preserved: the list is capped by
                    // dropping the tail, never the newest read.
                    const rest = state.recents.filter((item) => item.key !== entry.key);
                    return { recents: [entry, ...rest].slice(0, RECENTS_CAP) };
                }),
                forget: (ref) => set((state) => ({
                    recents: state.recents.filter((item) => item.ref !== ref),
                })),
            }),
            {
                name: 'openchamber-jira-issues',
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
        { store: 'jira-issues' },
    ),
);
