// The session backlog routes, `/api/openchamber/backlog/*`, as the composer's
// strip calls them. Every answer is parsed here, once, into the types the
// strip renders; a shape the server did not send fails the fetch rather than
// putting half-typed state on the row. The contract is the
// `packages/web/server/lib/session-backlog/DOCUMENTATION.md` shape.

import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';

const BACKLOG_ROUTE = '/api/openchamber/backlog';
const BACKLOG_REMOVE_ROUTE = '/api/openchamber/backlog/remove';
const BACKLOG_CLEAR_ROUTE = '/api/openchamber/backlog/clear';
const BACKLOG_RUN_ROUTE = '/api/openchamber/backlog/run';

const backlogItemSchema = z.object({
    /** The queue order key; the oldest head is the first to run. */
    id: z.string(),
    text: z.string(),
    createdAt: z.number(),
});
export type BacklogItem = z.infer<typeof backlogItemSchema>;

const backlogListSchema = z.object({
    sessionID: z.string(),
    items: z.array(backlogItemSchema),
    draining: z.boolean().catch(false),
});

const backlogRemoveOutcomeSchema = z.object({
    sessionID: z.string(),
    /** Whether the item was there to be taken out. */
    removed: z.boolean(),
});

const backlogClearOutcomeSchema = z.object({
    sessionID: z.string(),
    /** How many items the clear dropped. */
    removed: z.number(),
});

const backlogRunOutcomeSchema = z.object({
    sessionID: z.string(),
    started: z.boolean(),
    staged: z.number(),
    note: z.string(),
});
type BacklogRunOutcome = z.infer<typeof backlogRunOutcomeSchema>;

const errorSchema = z.object({ error: z.string() });

const errorTextFrom = async (response: Response, fallback: string) => {
    const raw = await response.json().catch(() => null);
    const parsed = errorSchema.safeParse(raw);
    return parsed.success ? parsed.data.error : fallback;
};

const readBody = async <T>(response: Response, schema: z.ZodType<T>, failure: string): Promise<T> => {
    const raw = await response.json().catch(() => null);
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
        throw new Error(failure);
    }
    return parsed.data;
};

/** The body the backlog POST routes take: the session, plus the item to remove. */
type BacklogPostBody = { sessionID: string; itemID?: string };

const postRoute = async (route: string, body: BacklogPostBody, fetchImpl: typeof runtimeFetch) => {
    return fetchImpl(route, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
};

export const backlogApi = {
    /** The session's staged items, oldest first; a session without a backlog answers empty. */
    list: async (sessionId: string, fetchImpl: typeof runtimeFetch = runtimeFetch): Promise<{ items: BacklogItem[]; draining: boolean }> => {
        const response = await fetchImpl(`${BACKLOG_ROUTE}?sessionID=${encodeURIComponent(sessionId)}`, {
            headers: { accept: 'application/json' },
        });
        if (!response.ok) {
            throw new Error(await errorTextFrom(response, 'The backlog could not be loaded'));
        }
        const data = await readBody(response, backlogListSchema, 'Backlog response did not match the expected shape');
        return { items: data.items, draining: data.draining };
    },

    /** Takes one staged item out of the queue; answers whether the client should refetch. */
    remove: async (sessionId: string, itemId: string, fetchImpl: typeof runtimeFetch = runtimeFetch): Promise<boolean> => {
        const response = await postRoute(BACKLOG_REMOVE_ROUTE, { sessionID: sessionId, itemID: itemId }, fetchImpl);
        if (!response.ok) {
            throw new Error(await errorTextFrom(response, 'The item could not be removed'));
        }
        const data = await readBody(response, backlogRemoveOutcomeSchema, 'Remove response did not match the expected shape');
        return data.removed;
    },

    /** Drops every staged item of the session and answers how many were dropped. */
    clear: async (sessionId: string, fetchImpl: typeof runtimeFetch = runtimeFetch): Promise<number> => {
        const response = await postRoute(BACKLOG_CLEAR_ROUTE, { sessionID: sessionId }, fetchImpl);
        if (!response.ok) {
            throw new Error(await errorTextFrom(response, 'The backlog could not be cleared'));
        }
        const data = await readBody(response, backlogClearOutcomeSchema, 'Clear response did not match the expected shape');
        return data.removed;
    },

    /**
     * Starts the drain: each staged item runs as its own turn, in order. The
     * server grades the refusals (an empty queue, a drain already going); the
     * message it sends is what the toast shows.
     */
    run: async (sessionId: string, fetchImpl: typeof runtimeFetch = runtimeFetch): Promise<BacklogRunOutcome> => {
        const response = await postRoute(BACKLOG_RUN_ROUTE, { sessionID: sessionId }, fetchImpl);
        if (!response.ok) {
            throw new Error(await errorTextFrom(response, 'The queue could not be started'));
        }
        return readBody(response, backlogRunOutcomeSchema, 'Run response did not match the expected shape');
    },
};
