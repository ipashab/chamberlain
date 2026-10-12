import { describe, expect, test } from 'bun:test';

import type { JsonValue } from '@openchamber/sdk';

import { fetchBitbucketPullView } from './pull-view-api';

const VIEW_BODY = {
    pull: {
        number: 110,
        url: 'https://bitbucket.example.com/projects/AUTO/repos/ai-reviewer/pull-requests/110',
        title: 'Remove the temporary exception',
        description: '',
        state: 'merged',
        author: 'Sv Gorbunov',
        createdAt: 1789660000000,
        updatedAt: 1789669800000,
        fromBranch: 'fix',
        toBranch: 'master',
        reviewers: [],
        checks: null,
    },
    files: [],
    comments: [],
    commits: [],
    truncated: { diff: false, comments: false, commits: false },
};

const jsonResponse = (status: number, body: JsonValue): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('fetchBitbucketPullView', () => {
    test('asks the route once and answers the parsed view', async () => {
        let asked = '';
        const result = await fetchBitbucketPullView(
            'https://bitbucket.example.com/projects/AUTO/repos/ai-reviewer/pull-requests/110',
            async (input: string | URL | Request) => {
                asked = String(input);
                return jsonResponse(200, VIEW_BODY);
            },
        );
        expect(asked).toBe('/api/openchamber/bitbucket/pulls/view?url=https%3A%2F%2Fbitbucket.example.com%2Fprojects%2FAUTO%2Frepos%2Fai-reviewer%2Fpull-requests%2F110');
        expect(result).toEqual({ ok: true, view: VIEW_BODY });
    });

    test('carries the route error kinds into the failure result', async () => {
        const result = await fetchBitbucketPullView('https://x.example.com/projects/A/repos/r/pull-requests/1', async () =>
            jsonResponse(409, { kind: 'wrong-instance', error: 'elsewhere' }),
        );
        expect(result).toEqual({ ok: false, kind: 'wrong-instance' });
    });

    test('answers unexpected when the error body carries no known kind', async () => {
        const result = await fetchBitbucketPullView('https://x.example.com/projects/A/repos/r/pull-requests/1', async () =>
            jsonResponse(502, { error: 'mystery' }),
        );
        expect(result).toEqual({ ok: false, kind: 'unexpected' });
    });

    test('answers unexpected when a good status carries a bad shape', async () => {
        const result = await fetchBitbucketPullView('https://x.example.com/projects/A/repos/r/pull-requests/1', async () =>
            jsonResponse(200, { hello: 'world' }),
        );
        expect(result).toEqual({ ok: false, kind: 'unexpected' });
    });

    test('answers unreachable when the fetch itself fails', async () => {
        const result = await fetchBitbucketPullView('https://x.example.com/projects/A/repos/r/pull-requests/1', async () => {
            throw new Error('network down');
        });
        expect(result).toEqual({ ok: false, kind: 'unreachable' });
    });

    test('parses the commits the server lists: sha, short sha, summary, date', async () => {
        const result = await fetchBitbucketPullView(
            'https://bitbucket.example.com/projects/AUTO/repos/ai-reviewer/pull-requests/110',
            async () => jsonResponse(200, {
                ...VIEW_BODY,
                commits: [
                    { sha: 'abc123def4567890', shortSha: 'abc123d', author: 'Sv Gorbunov', summary: 'Remove the exception', date: 1789660000000 },
                ],
                truncated: { diff: false, comments: false, commits: true },
            }),
        );
        if (!result.ok) throw new Error('expected a ready view');
        expect(result.view.commits).toEqual([
            { sha: 'abc123def4567890', shortSha: 'abc123d', author: 'Sv Gorbunov', summary: 'Remove the exception', date: 1789660000000 },
        ]);
        expect(result.view.truncated.commits).toBe(true);
    });

    test('parses the comments the server sends: author, anchor, thread state', async () => {
        const result = await fetchBitbucketPullView(
            'https://bitbucket.example.com/projects/AUTO/repos/ai-reviewer/pull-requests/110',
            async () =>
                jsonResponse(200, {
                    ...VIEW_BODY,
                    comments: [
                        {
                            id: 99001,
                            author: 'Robin Stone',
                            authorSlug: 'r.stone',
                            text: 'line, please',
                            createdAt: 1789750000000,
                            resolved: false,
                            severity: 'NORMAL',
                            // Where the comment hangs in the diff.
                            anchor: { path: 'autotests/src/client.py', line: 15, lineType: 'ADDED' },
                            replies: [],
                        },
                        {
                            id: 99002,
                            author: 'AIR',
                            authorSlug: 'ci',
                            text: '## Review run info',
                            createdAt: 1789664696177,
                            resolved: true,
                            severity: null,
                            // A comment of the overview carries no anchor.
                            anchor: null,
                            replies: [{ author: 'Sv Gorbunov', authorSlug: 'sgorbunov', text: 'Acknowledged.', createdAt: 1789664999000 }],
                        },
                    ],
                }),
        );
        if (!result.ok) throw new Error('expected a ready view');
        if (result.view.comments[0]?.anchor === undefined) throw new Error('expected the anchor to parse');
        expect(result.view.comments[0]?.anchor?.path).toBe('autotests/src/client.py');
        expect(result.view.comments[0]?.anchor?.line).toBe(15);
        expect(result.view.comments[0]?.anchor?.lineType).toBe('ADDED');
        expect(result.view.comments[1]?.anchor).toBeNull();
    });
});
