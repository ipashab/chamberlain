import { describe, expect, test } from 'bun:test';

import type { BitbucketDashboardPull } from '@/lib/bitbucket/pull-list-api';
import type { PullAnalysisEntry } from '@/components/bitbucket/pullAnalysisSession';
import { bucketOf, compareReviewRows, majorityDirectoryOf, reviewBoardRows, type PullVerdict, type ReviewRow } from './reviewBoard';

const pull = (overrides: Partial<BitbucketDashboardPull>): BitbucketDashboardPull => ({
    number: 1,
    url: `https://bitbucket.example.com/pulls/${overrides.number ?? 1}`,
    title: 'Some pull',
    state: 'open',
    author: null,
    authorSlug: null,
    repo: { project: 'PRJ', slug: 'repo' },
    createdAt: 100,
    updatedAt: 200,
    ...overrides,
});

const entry = (directory: string, sessionId: string): PullAnalysisEntry => ({
    sessionId,
    directory,
    startedAt: 1,
});

const row = (bucketState: {
    number?: number;
    updatedAt?: number | null;
    entry: PullAnalysisEntry | null;
    verdict: PullVerdict | null;
}): ReviewRow => {
    const thePull = pull({
        number: bucketState.number,
        updatedAt: bucketState.updatedAt ?? null,
        url: `https://bitbucket.example.com/pulls/${bucketState.number ?? 1}`,
    });
    const verdict = bucketState.verdict;
    return { pull: thePull, entry: bucketState.entry, verdict, bucket: bucketOf(bucketState.entry, verdict) };
};

describe('bucketOf', () => {
    test('an unread pull is unread, a read one is its verdict', () => {
        expect(bucketOf(null, null)).toBe('unread');
        expect(bucketOf(entry('a', 's1'), null)).toBe('read');
        expect(bucketOf(entry('a', 's1'), 'concerns')).toBe('concerns');
    });
});

describe('reviewBoardRows', () => {
    const entries = new Map<string, PullAnalysisEntry | null>([
        ['https://bitbucket.example.com/pulls/1', entry('/work/x', 's-concerns')],
        ['https://bitbucket.example.com/pulls/2', entry('/work/x', 's-ok')],
        ['https://bitbucket.example.com/pulls/3', entry('/work/x', 's-questions')],
        ['https://bitbucket.example.com/pulls/4', null],
        ['https://bitbucket.example.com/pulls/5', entry('/work/x', 's-unparsed')],
    ]);
    const verdicts = new Map<string, PullVerdict | null>([
        ['s-concerns', 'concerns'],
        ['s-ok', 'ok'],
        ['s-questions', 'questions'],
        ['s-unparsed', null],
    ]);

    test('open pulls only — merged and declined wait for no one', () => {
        const rows = reviewBoardRows(
            [pull({ number: 1 }), pull({ number: 2, state: 'merged' }), pull({ number: 3, state: 'closed' })],
            () => null,
            () => null,
        );
        expect(rows.map((r) => r.pull.number)).toEqual([1]);
    });

    test('the buckets land where a person is needed first', () => {
        const rows = reviewBoardRows(
            [1, 2, 3, 4, 5].map((number) => pull({ number, url: `https://bitbucket.example.com/pulls/${number}` })),
            (url) => entries.get(url) ?? null,
            (e) => verdicts.get(e.sessionId) ?? null,
        );
        expect(rows.map((r) => r.bucket)).toEqual(['concerns', 'questions', 'ok', 'read', 'unread']);
    });

    test('within a bucket the most recently touched pull sits on top', () => {
        const rows = reviewBoardRows(
            [pull({ number: 1, updatedAt: 100 }), pull({ number: 2, updatedAt: 300 }), pull({ number: 3, updatedAt: 200 })],
            () => null,
            () => null,
        );
        expect(rows.map((r) => r.pull.number)).toEqual([2, 3, 1]);
    });
});

describe('compareReviewRows', () => {
    test('the verdict buckets outrank the recent touch', () => {
        const concerns = row({ number: 1, updatedAt: 1, entry: entry('a', 's'), verdict: 'concerns' });
        const ok = row({ number: 2, updatedAt: 2, entry: entry('a', 's'), verdict: 'ok' });
        expect(compareReviewRows(ok, concerns)).toBeGreaterThan(0);
    });

    test('equal buckets fall back to recency', () => {
        const older = row({ number: 1, updatedAt: 1, entry: entry('a', 's'), verdict: 'ok' });
        const newer = row({ number: 2, updatedAt: 2, entry: entry('a', 's'), verdict: 'ok' });
        expect(compareReviewRows(newer, older)).toBeLessThan(0);
    });
});

describe('majorityDirectoryOf', () => {
    test('the directory most readings ran in wins', () => {
        expect(majorityDirectoryOf([
            entry('/work/x', 's1'),
            entry('/work/x', 's2'),
            entry('/work/y', 's3'),
        ])).toBe('/work/x');
    });

    test('no readings name no directory', () => {
        expect(majorityDirectoryOf([])).toBeNull();
    });
});
