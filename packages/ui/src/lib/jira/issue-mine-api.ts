// The account's own issues list's client: `/api/openchamber/jira/issues/my`,
// the board's landing GET. The server reads the token's own open issues —
// the not-done ones, newest first — with the fixed query the server itself
// owns; the failures are the viewer's own kinds, so the board words them
// the same way it words a failed read.
//
// The contract lives in `packages/web/server/lib/jira/DOCUMENTATION.md`.

import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';
import { issueHitSchema, type JiraIssueHit } from './issue-search-api';
import { type ViewErrorKind, VIEW_ERROR_KINDS } from './issue-view-api';

const ISSUE_MINE_ROUTE = '/api/openchamber/jira/issues/my';

const mineBodySchema = z.object({
    issues: z.array(issueHitSchema),
});

const mineErrorBodySchema = z.object({
    kind: z.enum(VIEW_ERROR_KINDS).nullish(),
});

type IssueMineResult =
    | { ok: true; issues: JiraIssueHit[] }
    | { ok: false; kind: ViewErrorKind };

/**
 * The account's own open issues, capped by the server. No parameters: the
 * list lands on the server's own cap. A non-2xx answer is the viewer's
 * failure kind, a 2xx with the wrong shape is `unexpected` — the list is
 * either wholly rows or wholly an explanation, never half of each.
 */
export const fetchMyJiraIssues = async (
    fetchImpl: typeof runtimeFetch = runtimeFetch,
): Promise<IssueMineResult> => {
    let response: Response;
    try {
        response = await fetchImpl(ISSUE_MINE_ROUTE, {
            headers: { accept: 'application/json' },
        });
    } catch {
        return { ok: false, kind: 'unreachable' };
    }
    const body = await response.json().catch(() => null);
    if (!response.ok) {
        const parsed = mineErrorBodySchema.safeParse(body);
        return { ok: false, kind: parsed.success ? (parsed.data.kind ?? 'unexpected') : 'unexpected' };
    }
    const parsed = mineBodySchema.safeParse(body);
    if (!parsed.success) {
        return { ok: false, kind: 'unexpected' };
    }
    return { ok: true, issues: parsed.data.issues };
};
