// The read-only issue view's client: `/api/openchamber/jira/issues/view`,
// the issue viewer's one GET. The server assembles everything — the
// details, the rendered description, the comments, the issue links, the
// subtasks, the attachments — from its own Jira connection; the token
// never crosses this boundary, so the viewer never sees more than the
// view itself.
//
// The contract lives in `packages/web/server/lib/jira/DOCUMENTATION.md`.
// Failures are a typed result, not a thrown prose error: every kind has
// its own words in the panel, and a shape the server did not send arrives
// as `unexpected` rather than half-typed rows.

import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';

const ISSUE_VIEW_ROUTE = '/api/openchamber/jira/issues/view';

export const VIEW_ERROR_KINDS = [
    'bad-ref',
    'unconfigured',
    'wrong-instance',
    'not-found',
    'unauthorized',
    'unreachable',
    'unexpected',
] as const;

export type ViewErrorKind = (typeof VIEW_ERROR_KINDS)[number];

/** One person as the view carries them: words, an account key, an avatar path. */
const personSchema = z.object({
    name: z.string().nullish(),
    key: z.string().nullish(),
    avatarPath: z.string().nullish(),
});

const iconedSchema = z.object({
    name: z.string().nullish(),
    iconPath: z.string().nullish(),
});

const statusSchema = z.object({
    name: z.string().nullish(),
    // Jira's own coarse state: 'new', 'indeterminate' or 'done'.
    category: z.string().nullish(),
});

const issueLinkTargetSchema = z.object({
    key: z.string(),
    summary: z.string().nullish(),
    statusName: z.string().nullish(),
    typeName: z.string().nullish(),
});

const jiraIssueViewSchema = z.object({
    issue: z.object({
        key: z.string(),
        url: z.string(),
        summary: z.string(),
        type: iconedSchema,
        status: statusSchema,
        resolution: z.string().nullish(),
        priority: iconedSchema,
        assignee: personSchema.nullish(),
        reporter: personSchema.nullish(),
        creator: personSchema.nullish(),
        created: z.string().nullish(),
        updated: z.string().nullish(),
        labels: z.array(z.string()),
        components: z.array(z.string()),
        fixVersions: z.array(z.string()),
        affectsVersions: z.array(z.string()),
        watchCount: z.number().nullish(),
        watcherNames: z.array(z.string()).nullish(),
        customFields: z.array(z.object({
            id: z.string(),
            name: z.string(),
            text: z.string(),
        })),
        epic: z.object({
            key: z.string(),
            name: z.string().nullish(),
            statusName: z.string().nullish(),
        }).nullish(),
        sprints: z.array(z.string()).nullish(),
    }),
    description: z.object({
        // The wiki markup Jira stores; the words the chat's ask quotes.
        wiki: z.string(),
        // The HTML the instance rendered; null the viewer falls back from.
        html: z.string().nullish(),
    }),
    comments: z.array(z.object({
        id: z.string().nullish(),
        author: personSchema.nullish(),
        created: z.string().nullish(),
        updated: z.string().nullish(),
        edited: z.boolean(),
        html: z.string().nullish(),
        text: z.string(),
    })),
    issueLinks: z.array(z.object({
        typeName: z.string().nullish(),
        // The relation spelled from this issue's side: "is blocked by"…
        relation: z.string().nullish(),
        issue: issueLinkTargetSchema,
    })),
    subtasks: z.array(issueLinkTargetSchema),
    attachments: z.array(z.object({
        id: z.string().nullish(),
        filename: z.string().nullish(),
        size: z.number().nullish(),
        created: z.string().nullish(),
        author: z.string().nullish(),
    })),
    truncated: z.object({
        comments: z.boolean(),
    }),
});

export type JiraIssueView = z.infer<typeof jiraIssueViewSchema>;

type IssueViewResult =
    | { ok: true; view: JiraIssueView }
    | { ok: false; kind: ViewErrorKind };

const viewErrorKindSchema = z.enum(VIEW_ERROR_KINDS);

/** The route's own error body: `{ kind, error }`, parsed at this boundary. */
const viewErrorBodySchema = z.object({
    kind: viewErrorKindSchema.nullish(),
});

/**
 * One issue, read whole. `ref` is a browse URL or a bare issue key; the
 * server decides which instance it belongs to. A non-2xx answer is the
 * viewer's failure kind, a 2xx with the wrong shape is `unexpected` — in
 * both cases the viewer draws its own error state, never partial data.
 */
export const fetchJiraIssueView = async (
    ref: string,
    fetchImpl: typeof runtimeFetch = runtimeFetch,
): Promise<IssueViewResult> => {
    const search = new URLSearchParams({ ref });
    let response: Response;
    try {
        response = await fetchImpl(`${ISSUE_VIEW_ROUTE}?${search.toString()}`, {
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
    const parsed = jiraIssueViewSchema.safeParse(body);
    if (!parsed.success) {
        return { ok: false, kind: 'unexpected' };
    }
    return { ok: true, view: parsed.data };
};
