import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type { BitbucketPullView } from '@/lib/bitbucket/pull-view-api';
import { parseDiffRows } from '@/lib/bitbucket/pullDiff';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';

import { attachCommentAsk, attachFileAsk, attachLinesAsk } from './pullAsk';

// One file, one patch, the rows a question can aim at: the numbers the
// hunk's own header promises, the same rows every ask quotes from.
const DIFF = [
    'diff --git a/src/client.py b/src/client.py',
    '--- a/src/client.py',
    '+++ b/src/client.py',
    '@@ -10,4 +10,6 @@ def check(msisdn):',
    ' def check(msisdn):',
    '-    return old()',
    '+    headers = build()',
    '+    return new(headers)',
    ' ',
    ' # trailing note',
].join('\n');

const FILE: BitbucketPullView['files'][number] = {
    path: 'src/client.py',
    changeType: 'modify',
    truncated: false,
    diffText: DIFF,
};

type PullComment = BitbucketPullView['comments'][number];

const ANCHORED_COMMENT: PullComment = {
    id: 1,
    author: 'Robin Stone',
    text: 'line, please',
    resolved: false,
    severity: null,
    anchor: { path: 'src/client.py', line: 11, lineType: 'ADDED' },
    replies: [{ author: 'Sv Gorbunov', text: 'Acknowledged.', createdAt: 1789664999000 }],
};

const VIEW: BitbucketPullView = {
    pull: {
        number: 110,
        url: 'https://bitbucket.example.com/projects/AUTO/repos/ai-reviewer/pull-requests/110',
        title: 'Remove the temporary exception',
        description: '',
        state: 'open',
        reviewers: [],
    },
    files: [FILE],
    comments: [],
    commits: [],
    truncated: { diff: false, comments: false, commits: false },
};

const TARGET = { directory: '/repo', sessionKey: 'ses_ask' };

const draftOf = () => {
    const drafts = useInlineCommentDraftStore.getState().getDrafts(TARGET);
    expect(drafts).toHaveLength(1);
    return drafts[0];
};

describe('pull asks', () => {
    const original = { ...useSessionUIStore.getState() };

    beforeEach(() => {
        useSessionUIStore.setState({ currentSessionId: 'ses_ask', getDirectoryForSession: () => '/repo' });
        useInlineCommentDraftStore.setState({ drafts: {}, touchedAt: {} });
    });

    afterEach(() => {
        useSessionUIStore.setState({
            currentSessionId: original.currentSessionId,
            getDirectoryForSession: original.getDirectoryForSession,
        });
        useInlineCommentDraftStore.setState({ drafts: {}, touchedAt: {} });
    });

    describe('attachLinesAsk', () => {
        const rows = parseDiffRows(DIFF);

        test('pins one row with the hunk window it lives in', () => {
            // Row 6 is `+ headers = build()`: the new file's line 11.
            const result = attachLinesAsk(VIEW, FILE, rows, 6, 6);
            expect(result).toEqual({ ok: true });
            const draft = draftOf();
            expect(draft?.fileLabel).toBe('Bitbucket PR #110: src/client.py:11');
            expect(draft?.startLine).toBe(11);
            expect(draft?.endLine).toBe(11);
            expect(draft?.code).toContain('  11| +    headers = build()');
            // The window carries the rows around it, context included.
            expect(draft?.code).toContain('  10|  def check(msisdn):');
        });

        test('reads the same quote whichever end the span was taken from', () => {
            const forward = attachLinesAsk(VIEW, FILE, rows, 6, 7);
            expect(forward).toEqual({ ok: true });
            const draft = draftOf();
            expect(draft?.fileLabel).toBe('Bitbucket PR #110: src/client.py:11-12');
            expect(draft?.startLine).toBe(11);
            expect(draft?.endLine).toBe(12);

            useInlineCommentDraftStore.getState().clearDrafts(TARGET);
            const backward = attachLinesAsk(VIEW, FILE, rows, 7, 6);
            expect(backward).toEqual({ ok: true });
            expect(draftOf()?.fileLabel).toBe('Bitbucket PR #110: src/client.py:11-12');
        });

        test('a span landing on a hunk head still aims at its numbered rows', () => {
            // Index 3 is the `@@` head: it borrows no number, so the span
            // walks inward to the context row (old 10 / new 10) and the
            // added row (new 11).
            const result = attachLinesAsk(VIEW, FILE, rows, 3, 6);
            expect(result).toEqual({ ok: true });
            expect(draftOf()?.fileLabel).toBe('Bitbucket PR #110: src/client.py:10-11');
        });

        test('without a session there is nothing to pin to', () => {
            useSessionUIStore.setState({ currentSessionId: null });
            const result = attachLinesAsk(VIEW, FILE, rows, 6, 6);
            expect(result).toEqual({ ok: false, reason: 'no-session' });
            expect(useInlineCommentDraftStore.getState().getDrafts(TARGET)).toEqual([]);
        });
    });

    describe('attachFileAsk', () => {
        test('pins the file\'s whole patch exactly as the server rebuilt it', () => {
            const result = attachFileAsk(VIEW, FILE);
            expect(result).toEqual({ ok: true });
            const draft = draftOf();
            expect(draft?.fileLabel).toBe('Bitbucket PR #110: src/client.py (diff)');
            expect(draft?.code).toBe(DIFF);
        });
    });

    describe('attachCommentAsk', () => {
        test('an anchored comment carries its thread and the diff window of its line', () => {
            const result = attachCommentAsk(VIEW, ANCHORED_COMMENT);
            expect(result).toEqual({ ok: true });
            const draft = draftOf();
            expect(draft?.fileLabel).toBe('Bitbucket PR #110: comment by Robin Stone (src/client.py)');
            expect(draft?.code).toContain('comment by Robin Stone');
            expect(draft?.code).toContain('line, please');
            expect(draft?.code).toContain('Reply by Sv Gorbunov: Acknowledged.');
            // The ADDED anchor counts the new side: the window shows the
            // added row the comment hangs on.
            expect(draft?.code).toContain('## Diff context around src/client.py:11');
            expect(draft?.code).toContain('  11| +    headers = build()');
            expect(draft?.startLine).toBe(11);
            expect(draft?.endLine).toBe(11);
        });

        test('a REMOVED anchor reads the old side of the patch', () => {
            const comment: PullComment = {
                ...ANCHORED_COMMENT,
                anchor: { path: 'src/client.py', line: 11, lineType: 'REMOVED' },
            };
            const result = attachCommentAsk(VIEW, comment);
            expect(result).toEqual({ ok: true });
            expect(draftOf()?.code).toContain('  11| -    return old()');
        });

        test('a chosen reply becomes the subject, its parent the context', () => {
            const reply = ANCHORED_COMMENT.replies[0];
            if (!reply) throw new Error('expected a reply in the fixture');
            const result = attachCommentAsk(VIEW, ANCHORED_COMMENT, reply);
            expect(result).toEqual({ ok: true });
            const draft = draftOf();
            expect(draft?.fileLabel).toBe('Bitbucket PR #110: reply by Sv Gorbunov (src/client.py)');
            expect(draft?.code).toContain('reply by Sv Gorbunov');
            expect(draft?.code).toContain('In reply to Robin Stone');
            expect(draft?.code).toContain('The reply:\nAcknowledged.');
            // The subject's own code window rides along with it.
            expect(draft?.code).toContain('## Diff context around src/client.py:11');
        });

        test('a pull-level comment carries the pull\'s own material', () => {
            const comment: PullComment = { ...ANCHORED_COMMENT, anchor: null };
            const result = attachCommentAsk(VIEW, comment);
            expect(result).toEqual({ ok: true });
            const draft = draftOf();
            expect(draft?.fileLabel).toBe('Bitbucket PR #110: comment by Robin Stone');
            expect(draft?.code).toContain('line, please');
            // No anchor, no window: the subject is the change as a whole.
            expect(draft?.code).not.toContain('## Diff context');
            expect(draft?.code).toContain('## Changed files (1)');
            expect(draft?.startLine).toBe(0);
        });
    });
});
