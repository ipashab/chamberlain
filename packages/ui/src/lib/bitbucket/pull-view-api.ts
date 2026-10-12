// The read-only pull view's client: `/api/openchamber/bitbucket/pulls/view`,
// the PR viewer's one GET. The server assembles everything — meta,
// reviewers, checks, commits, files with their unified diffs, comments —
// from its own Bitbucket connection; the token never crosses this
// boundary, so the viewer never sees more than the view itself.
//
// The contract lives in `packages/web/server/lib/bitbucket/DOCUMENTATION.md`.
// Failures are a typed result, not a thrown prose error: every kind has its
// own words in the dialog, and the shape the server did not send arrives as
// `unexpected` rather than half-typed rows.

import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';

const PULL_VIEW_ROUTE = '/api/openchamber/bitbucket/pulls/view';

export const VIEW_ERROR_KINDS = [
    'bad-url',
    'unconfigured',
    'wrong-instance',
    'not-found',
    'unauthorized',
    'unreachable',
    'unexpected',
] as const;

export type ViewErrorKind = (typeof VIEW_ERROR_KINDS)[number];

export type BitbucketPullView = z.infer<typeof bitbucketPullViewSchema>;

export const bitbucketPullViewSchema = z.object({    pull: z.object({
        number: z.number(),
        url: z.string(),
        title: z.string(),
        description: z.string(),
        state: z.enum(['open', 'merged', 'closed']),
        author: z.string().nullish(),
        authorSlug: z.string().nullish(),
        createdAt: z.number().nullish(),
        updatedAt: z.number().nullish(),
        fromBranch: z.string().nullish(),
        toBranch: z.string().nullish(),
        reviewers: z.array(z.object({
            name: z.string().nullish(),
            slug: z.string().nullish(),
            approved: z.boolean(),
        })),
        checks: z.object({
            state: z.enum(['success', 'failure', 'pending', 'unknown']),
            total: z.number(),
        }).nullish(),
    }),
    files: z.array(z.object({
        path: z.string(),
        changeType: z.enum(['add', 'delete', 'modify']),
        truncated: z.boolean(),
        diffText: z.string(),
    })),
    comments: z.array(z.object({
        id: z.number(),
        author: z.string().nullish(),
        authorSlug: z.string().nullish(),
        text: z.string(),
        createdAt: z.number().nullish(),
        resolved: z.boolean(),
        severity: z.string().nullish(),
        // Where the comment hangs in the diff; null is a pull-level comment.
        anchor: z
            .object({
                path: z.string(),
                line: z.number().nullish(),
                lineType: z.string().nullish(),
            })
            .nullish(),
        replies: z.array(z.object({
            author: z.string().nullish(),
            authorSlug: z.string().nullish(),
            text: z.string(),
            createdAt: z.number().nullish(),
        })),
    })),
    commits: z.array(z.object({
        sha: z.string(),
        shortSha: z.string(),
        author: z.string().nullish(),
        summary: z.string().nullish(),
        date: z.number().nullish(),
    })),
    truncated: z.object({
        diff: z.boolean(),
        comments: z.boolean(),
        commits: z.boolean(),
    }),
});

export type PullViewResult =
    | { ok: true; view: BitbucketPullView }
    | { ok: false; kind: ViewErrorKind };

const viewErrorKindSchema = z.enum(VIEW_ERROR_KINDS);

/** The route's own error body: `{ kind, error }`, parsed at this boundary. */
const viewErrorBodySchema = z.object({
    kind: viewErrorKindSchema.nullish(),
});

/**
 * One pull request, read whole. `url` is any address the board's chip could
 * carry; the server decides which instance it belongs to. A non-2xx answer
 * is the dialog's failure kind, a 2xx with the wrong shape is `unexpected` —
 * in both cases the viewer draws its own error state, never partial data.
 */
export const fetchBitbucketPullView = async (
    url: string,
    fetchImpl: typeof runtimeFetch = runtimeFetch,
): Promise<PullViewResult> => {
    const search = new URLSearchParams({ url });
    let response: Response;
    try {
        response = await fetchImpl(`${PULL_VIEW_ROUTE}?${search.toString()}`, {
            headers: { accept: 'application/json' },
        });
    } catch {
        return { ok: false, kind: 'unreachable' };
    }
    const body = await response.json().catch(() => null);
    if (!response.ok) {
        const parsed = viewErrorBodySchema.safeParse(body);
        return { ok: false, kind: parsed.success ? (parsed.data.kind ?? 'unexpected') : 'unexpected' };
    }
    const parsed = bitbucketPullViewSchema.safeParse(body);
    if (!parsed.success) {
        return { ok: false, kind: 'unexpected' };
    }
    return { ok: true, view: parsed.data };
};
