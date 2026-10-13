// The issue search's client: `/api/openchamber/jira/issues/search`, the
// Jira surface's quick finder. The server sanitizes the words before they
// reach the instance; the failures are the viewer's own kinds, so the
// panel words them the same way it words a failed read.
//
// The contract lives in `packages/web/server/lib/jira/DOCUMENTATION.md`.

import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';
import { type ViewErrorKind, VIEW_ERROR_KINDS } from './issue-view-api';

const ISSUE_SEARCH_ROUTE = '/api/openchamber/jira/issues/search';

export type JiraIssueHit = z.infer<typeof issueHitSchema>;

/** One search row: the coordinates a click needs, nothing more. */
const issueHitSchema = z.object({
    key: z.string(),
    url: z.string(),
    summary: z.string(),
    updated: z.string().nullish(),
    statusName: z.string().nullish(),
    typeName: z.string().nullish(),
});

const searchBodySchema = z.object({
    issues: z.array(issueHitSchema),
});

type IssueSearchResult =
    | { ok: true; issues: JiraIssueHit[] }
    | { ok: false; kind: ViewErrorKind };

const searchErrorBodySchema = z.object({
    kind: z.enum(VIEW_ERROR_KINDS).nullish(),
});

/**
 * The issues whose words match. A non-2xx answer is the viewer's failure
 * kind, a 2xx with the wrong shape is `unexpected` — the list is either
 * wholly rows or wholly an explanation, never half of each.
 */
export const fetchJiraIssueSearch = async (
    query: string,
    fetchImpl: typeof runtimeFetch = runtimeFetch,
): Promise<IssueSearchResult> => {
    const search = new URLSearchParams({ q: query });
    let response: Response;
    try {
        response = await fetchImpl(`${ISSUE_SEARCH_ROUTE}?${search.toString()}`, {
            headers: { accept: 'application/json' },
        });
    } catch {
        return { ok: false, kind: 'unreachable' };
    }
    const body = await response.json().catch(() => null);
    if (!response.ok) {
        const parsed = searchErrorBodySchema.safeParse(body);
        return { ok: false, kind: parsed.success ? (parsed.data.kind ?? 'unexpected') : 'unexpected' };
    }
    const parsed = searchBodySchema.safeParse(body);
    if (!parsed.success) {
        return { ok: false, kind: 'unexpected' };
    }
    return { ok: true, issues: parsed.data.issues };
};
