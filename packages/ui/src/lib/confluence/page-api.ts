// The read-only page reader's client: `/api/openchamber/confluence/pages/*`,
// the Confluence surface's two GETs — the quick page search and one page,
// read whole. The server assembles everything — the rendered body, the
// space, the version — from its own Confluence connection; the token never
// crosses this boundary, so the reader never sees more than the view
// itself.
//
// The contract lives in
// `packages/web/server/lib/confluence/DOCUMENTATION.md`. Failures are a
// typed result, not a thrown prose error: every kind has its own words in
// the panel, and a shape the server did not send arrives as `unexpected`
// rather than half-typed rows.

import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';

const PAGE_SEARCH_ROUTE = '/api/openchamber/confluence/pages/search';
const PAGE_VIEW_ROUTE = '/api/openchamber/confluence/pages/view';

export const PAGE_ERROR_KINDS = [
    'bad-ref',
    'unconfigured',
    'not-found',
    'unauthorized',
    'unreachable',
    'unexpected',
] as const;

export type PageErrorKind = (typeof PAGE_ERROR_KINDS)[number];

const pageErrorKindSchema = z.enum(PAGE_ERROR_KINDS);

/** The route's own error body: `{ kind, error }`, parsed at this boundary. */
const pageErrorBodySchema = z.object({
    kind: pageErrorKindSchema.nullish(),
});

/** One search row: enough to pick a page, nothing the reader cannot draw. */
export const confluenceSearchRowSchema = z.object({
    id: z.string(),
    title: z.string(),
    space: z.object({
        key: z.string().nullish(),
        name: z.string().nullish(),
    }),
    lastUpdated: z.string().nullish(),
    url: z.string().nullish(),
});

export type ConfluenceSearchRow = z.infer<typeof confluenceSearchRowSchema>;

export const confluencePageViewSchema = z.object({
    id: z.string(),
    title: z.string(),
    space: z.object({
        key: z.string().nullish(),
        name: z.string().nullish(),
    }),
    version: z.number().nullish(),
    updatedAt: z.string().nullish(),
    updatedBy: z.string().nullish(),
    url: z.string(),
    html: z.string(),
    truncated: z.boolean(),
});

export type ConfluencePageView = z.infer<typeof confluencePageViewSchema>;

export type SearchResult =
    | { ok: true; rows: ConfluenceSearchRow[] }
    | { ok: false; kind: PageErrorKind };

export type PageViewResult =
    | { ok: true; view: ConfluencePageView }
    | { ok: false; kind: PageErrorKind };

/**
 * The page finder: plain words, capped rows. A non-2xx answer is the
 * reader's failure kind, a 2xx with the wrong shape is `unexpected` — in
 * both cases the reader draws its own error state, never partial rows.
 */
export const fetchConfluenceSearch = async (
    query: string,
    fetchImpl: typeof runtimeFetch = runtimeFetch,
): Promise<SearchResult> => {
    const search = new URLSearchParams({ q: query });
    let response: Response;
    try {
        response = await fetchImpl(`${PAGE_SEARCH_ROUTE}?${search.toString()}`, {
            headers: { accept: 'application/json' },
        });
    } catch {
        return { ok: false, kind: 'unreachable' };
    }
    const body = await response.json().catch(() => null);
    if (!response.ok) {
        const parsed = pageErrorBodySchema.safeParse(body);
        return { ok: false, kind: parsed.success ? (parsed.data.kind ?? 'unexpected') : 'unexpected' };
    }
    const parsed = z.object({ results: z.array(confluenceSearchRowSchema) }).safeParse(body);
    if (!parsed.success) {
        return { ok: false, kind: 'unexpected' };
    }
    return { ok: true, rows: parsed.data.results };
};

/**
 * One page, read whole. `id` is the page's own numeric id — the same id
 * the instance's URL carries after `/pages/`.
 */
export const fetchConfluencePageView = async (
    id: string,
    fetchImpl: typeof runtimeFetch = runtimeFetch,
): Promise<PageViewResult> => {
    const search = new URLSearchParams({ id });
    let response: Response;
    try {
        response = await fetchImpl(`${PAGE_VIEW_ROUTE}?${search.toString()}`, {
            headers: { accept: 'application/json' },
        });
    } catch {
        return { ok: false, kind: 'unreachable' };
    }
    const body = await response.json().catch(() => null);
    if (!response.ok) {
        const parsed = pageErrorBodySchema.safeParse(body);
        return { ok: false, kind: parsed.success ? (parsed.data.kind ?? 'unexpected') : 'unexpected' };
    }
    const parsed = confluencePageViewSchema.safeParse(body);
    if (!parsed.success) {
        return { ok: false, kind: 'unexpected' };
    }
    return { ok: true, view: parsed.data };
};
