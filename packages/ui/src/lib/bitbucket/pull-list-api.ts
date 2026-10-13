// The account's pulls list's client: `/api/openchamber/bitbucket/pulls`, the
// pull surface's one landing GET. The server reads the token's own
// dashboard — the pulls the account authored or reviews — keeps every
// state (open rows capped, closed rows riding along) with the same state
// words the team board's chips read; the failures are the viewer's own
// kinds, so the panel words them the same way it words a failed read.
//
// The contract lives in `packages/web/server/lib/bitbucket/DOCUMENTATION.md`.

import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';
import { type ViewErrorKind, VIEW_ERROR_KINDS } from './pull-view-api';

const PULL_LIST_ROUTE = '/api/openchamber/bitbucket/pulls';

export type BitbucketDashboardPull = z.infer<typeof dashboardPullSchema>;

/** One dashboard row: the coordinates a click needs, nothing more. */
const dashboardPullSchema = z.object({
    number: z.number(),
    url: z.string(),
    title: z.string(),
    state: z.enum(['open', 'merged', 'closed']),
    author: z.string().nullish(),
    authorSlug: z.string().nullish(),
    repo: z.object({
        project: z.string(),
        slug: z.string(),
    }),
    createdAt: z.number().nullish(),
    updatedAt: z.number().nullish(),
});

const openPullsBodySchema = z.object({
    pulls: z.array(dashboardPullSchema),
    truncated: z.boolean(),
});

type PullListResult =
    | { ok: true; pulls: BitbucketDashboardPull[]; truncated: boolean }
    | { ok: false; kind: ViewErrorKind };

const listErrorBodySchema = z.object({
    kind: z.enum(VIEW_ERROR_KINDS).nullish(),
});

/**
 * The pulls of the configured account, open ones capped and closed ones
 * riding along. No parameters: the panel lands on the server's own cap.
 * A non-2xx answer is the viewer's failure kind, a 2xx with the wrong
 * shape is `unexpected` — the list is either wholly rows or wholly an
 * explanation, never half of each.
 */
export const fetchBitbucketDashboardPulls = async (
    fetchImpl: typeof runtimeFetch = runtimeFetch,
): Promise<PullListResult> => {
    let response: Response;
    try {
        response = await fetchImpl(PULL_LIST_ROUTE, {
            headers: { accept: 'application/json' },
        });
    } catch {
        return { ok: false, kind: 'unreachable' };
    }
    const body = await response.json().catch(() => null);
    if (!response.ok) {
        const parsed = listErrorBodySchema.safeParse(body);
        return { ok: false, kind: parsed.success ? (parsed.data.kind ?? 'unexpected') : 'unexpected' };
    }
    const parsed = openPullsBodySchema.safeParse(body);
    if (!parsed.success) {
        return { ok: false, kind: 'unexpected' };
    }
    return { ok: true, pulls: parsed.data.pulls, truncated: parsed.data.truncated };
};
