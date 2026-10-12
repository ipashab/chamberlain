// The open pulls list's client: `/api/openchamber/bitbucket/pulls`, the
// pull surface's one landing GET. The server reads the token's own
// dashboard — the pulls the account authored or reviews — keeps the open
// ones and caps them; the failures are the viewer's own kinds, so the
// panel words them the same way it words a failed read.
//
// The contract lives in `packages/web/server/lib/bitbucket/DOCUMENTATION.md`.

import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';
import { type ViewErrorKind, VIEW_ERROR_KINDS } from './pull-view-api';

const PULL_LIST_ROUTE = '/api/openchamber/bitbucket/pulls';

export type BitbucketOpenPull = z.infer<typeof openPullSchema>;

/** One dashboard row: the coordinates a click needs, nothing more. */
const openPullSchema = z.object({
    number: z.number(),
    url: z.string(),
    title: z.string(),
    state: z.literal('open'),
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
    pulls: z.array(openPullSchema),
    truncated: z.boolean(),
});

export type PullListResult =
    | { ok: true; pulls: BitbucketOpenPull[]; truncated: boolean }
    | { ok: false; kind: ViewErrorKind };

const listErrorBodySchema = z.object({
    kind: z.enum(VIEW_ERROR_KINDS).nullish(),
});

/**
 * The open pulls of the configured account. No parameters: the panel lands
 * on the server's own cap. A non-2xx answer is the viewer's failure kind,
 * a 2xx with the wrong shape is `unexpected` — the list is either wholly
 * rows or wholly an explanation, never half of each.
 */
export const fetchBitbucketOpenPulls = async (
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
