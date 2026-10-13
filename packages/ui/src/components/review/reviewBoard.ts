// The review board's pure half: the ordering its rows hang on, and the
// directory its verdicts resolve in. Rows land by what the last reading
// said — concerns first, questions next, approvals after them, reads
// with no parsed verdict, and the unread tail — so the top of the board
// is always where a person is needed next, not where the instance
// happened to list its pulls.

import type { BitbucketDashboardPull } from '@/lib/bitbucket/pull-list-api';
import type { PullAnalysisEntry } from '@/components/bitbucket/pullAnalysisSession';

/** The verdicts a reading's answer names; the board's own vocabulary for them. */
export type PullVerdict = 'ok' | 'questions' | 'concerns';

/** Where a row sits on the board: the verdict it carries, or the reading's shadow. */
export type ReviewBucket = 'concerns' | 'questions' | 'ok' | 'read' | 'unread';

export type ReviewRow = {
    pull: BitbucketDashboardPull;
    entry: PullAnalysisEntry | null;
    verdict: PullVerdict | null;
    bucket: ReviewBucket;
};

const BUCKET_RANK = {
    concerns: 0,
    questions: 1,
    ok: 2,
    read: 3,
    unread: 4,
} satisfies Record<ReviewBucket, number>;

/**
 * A row's bucket, straight from its facts: a pull nobody read is unread, a
 * pull whose reading never produced a parseable verdict is still read, and
 * everything else sits under the verdict the reading itself named.
 */
export const bucketOf = (entry: PullAnalysisEntry | null, verdict: PullVerdict | null): ReviewBucket => {
    if (entry === null) return 'unread';
    return verdict === null ? 'read' : verdict;
};

/**
 * The board's own ordering: the bucket first — where a person is needed
 * next — then the most recently touched pull within it, so old rows sink
 * instead of crowding the top.
 */
export const compareReviewRows = (left: ReviewRow, right: ReviewRow): number => {
    const rank = BUCKET_RANK[left.bucket] - BUCKET_RANK[right.bucket];
    if (rank !== 0) return rank;
    const leftStamp = left.pull.updatedAt ?? left.pull.createdAt ?? 0;
    const rightStamp = right.pull.updatedAt ?? right.pull.createdAt ?? 0;
    return rightStamp - leftStamp;
};

/**
 * The board's rows: this directory's open pulls, each with its remembered
 * reading and the verdict that reading's answer carried. The state filter
 * is the server's own cap's sibling — the board is about what waits, and
 * merged or declined pulls wait for no one.
 */
export const reviewBoardRows = (
    pulls: readonly BitbucketDashboardPull[],
    entryOfUrl: (url: string) => PullAnalysisEntry | null,
    verdictOfEntry: (entry: PullAnalysisEntry) => PullVerdict | null,
): ReviewRow[] =>
    pulls
        .filter((pull) => pull.state === 'open')
        .map((pull): ReviewRow => {
            const entry = entryOfUrl(pull.url);
            const verdict = entry === null ? null : verdictOfEntry(entry);
            return { pull, entry, verdict, bucket: bucketOf(entry, verdict) };
        })
        .sort(compareReviewRows);

/**
 * The directory where the board's verdicts resolve: the one its readings
 * mostly ran in. Verdicts live in per-directory stores, and the board
 * subscribes to one of them; readings elsewhere still fetch their
 * messages, but their rows honestly say «read» — a board that guesses
 * at a verdict it did not watch would be lying with a straight face.
 */
export const majorityDirectoryOf = (entries: readonly PullAnalysisEntry[]): string | null => {
    const counts = new Map<string, number>();
    let best: { directory: string; count: number } | null = null;
    for (const entry of entries) {
        const count = (counts.get(entry.directory) ?? 0) + 1;
        counts.set(entry.directory, count);
        if (best === null || count > best.count) {
            best = { directory: entry.directory, count };
        }
    }
    return best?.directory ?? null;
};
