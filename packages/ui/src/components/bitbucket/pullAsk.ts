import type { BitbucketPullView } from '@/lib/bitbucket/pull-view-api';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';
import {
    anchorRowIndex,
    excerptAround,
    excerptRange,
    parseDiffRows,
    rowsAsQuote,
    type DiffRow,
} from '@/lib/bitbucket/pullDiff';
import { buildPullViewMaterial } from './pullViewMaterial';

export type PullAskResult =
    | { ok: true }
    | { ok: false; reason: 'no-session' | 'rejected' };

/**
 * The one door every ask goes through: the current session pins the quote
 * to its next message, and a workable draft store accepts it. Shared by
 * the line, the range, the file, the comment and the pull itself, because
 * the answer never differs — only the label and the material do.
 *
 * Plain store reads, no i18n: the caller owns the words it answers with.
 */
const addQuoteDraft = (
    label: string,
    code: string,
    language: string,
    startLine: number,
    endLine: number,
): PullAskResult => {
    const { currentSessionId, getDirectoryForSession } = useSessionUIStore.getState();
    const directory = currentSessionId ? getDirectoryForSession(currentSessionId) : null;
    if (!currentSessionId || !directory) {
        return { ok: false, reason: 'no-session' };
    }
    const accepted = useInlineCommentDraftStore.getState().addDraft(
        { directory, sessionKey: currentSessionId },
        {
            source: 'file-quote',
            fileLabel: label,
            startLine,
            endLine,
            code,
            language,
            text: '',
        },
    );
    return accepted === null ? { ok: false, reason: 'rejected' } : { ok: true };
};

/**
 * Pin one pull request to the next message of the current session as a
 * labeled quote. The same flow the inline code comments use: the composer
 * shows the chip, the user asks the question, the material rides along.
 * Nothing is sent from here — the pin is a promise about the next message.
 */
export const attachPullAsk = (view: BitbucketPullView): PullAskResult => {
    const label = `Bitbucket PR #${view.pull.number}: ${view.pull.title}`.slice(0, 80);
    return addQuoteDraft(label, buildPullViewMaterial(view), 'markdown', 0, 0);
};

/**
 * Rows of one file's diff — one line or a chosen span, endpoints included —
 * pinned for the next message the same way the whole pull is: the label
 * names the file and the line span, the code carries the hunk window the
 * lines live in — numbered rows so the reader can see where they sit — and
 * the user writes the question in the composer. Nothing is sent from here,
 * and the material stays inside the hunk: a question about a few lines does
 * not need the whole pull to answer it. `fromIndex` and `toIndex` may
 * arrive in either order; the span reads the same both ways.
 */
export const attachLinesAsk = (
    view: BitbucketPullView,
    file: { path: string },
    rows: readonly DiffRow[],
    fromIndex: number,
    toIndex: number,
): PullAskResult => {
    const first = rows[Math.min(fromIndex, toIndex)];
    const last = rows[Math.max(fromIndex, toIndex)];
    const low = Math.min(fromIndex, toIndex);
    const high = Math.max(fromIndex, toIndex);
    if (!first || !last) {
        return { ok: false, reason: 'rejected' };
    }
    // The endpoints walk inward to the nearest row a side has promised a
    // number: a span dragged raw may begin or end on a hunk head, and the
    // question still aims at the code rows that were meant.
    const numbered = (row: DiffRow): boolean => row.oldLine !== null || row.newLine !== null;
    let startIndex = low;
    while (startIndex < high && !numbered(rows[startIndex])) startIndex += 1;
    let endIndex = high;
    while (endIndex > startIndex && !numbered(rows[endIndex])) endIndex -= 1;
    const startRow = rows[startIndex];
    const endRow = rows[endIndex];
    if (!startRow || !endRow || (startRow.oldLine === null && startRow.newLine === null)) {
        return { ok: false, reason: 'rejected' };
    }
    const startRef = startRow.newLine ?? startRow.oldLine;
    const endRef = endRow.newLine ?? endRow.oldLine;
    if (startRef === null || endRef === null) {
        return { ok: false, reason: 'rejected' };
    }
    const spanLow = Math.min(startRef, endRef);
    const spanHigh = Math.max(startRef, endRef);
    const anchor = startRef === endRef ? `${file.path}:${startRef}` : `${file.path}:${spanLow}-${spanHigh}`;
    const label = `Bitbucket PR #${view.pull.number}: ${anchor}`.slice(0, 120);
    const code = rowsAsQuote(excerptRange(rows, low, high));
    return addQuoteDraft(label, code, '', spanLow, spanHigh);
};

/**
 * A file's whole patch, pinned the same way: the label names the file, the
 * code is the unified diff exactly as the server rebuilt it — `diff --git`,
 * file heads, hunks, prefixed lines — capped only where the instance capped
 * it. A question about the change as a whole reads better from the whole
 * patch than from a window around one line.
 */
export const attachFileAsk = (
    view: BitbucketPullView,
    file: { path: string; diffText: string },
): PullAskResult => {
    const label = `Bitbucket PR #${view.pull.number}: ${file.path} (diff)`.slice(0, 120);
    return addQuoteDraft(label, file.diffText || '', '', 0, 0);
};

/**
 * One comment thread — the comment, its replies, where it hangs and the
 * code it talks about — pinned for the next message. An anchored comment
 * carries the hunk window around its line of the file's diff, so the
 * question about the note can see the note's subject; a comment of the
 * overview carries the pull's own material, because its subject is the
 * change as a whole. A chosen `reply` becomes the subject instead, with
 * its parent quoted as the thread it answers. Nothing is sent from here,
 * and the author's words ride along verbatim.
 */
export const attachCommentAsk = (
    view: BitbucketPullView,
    comment: BitbucketPullView['comments'][number],
    reply?: BitbucketPullView['comments'][number]['replies'][number],
): PullAskResult => {
    const anchor = comment.anchor ?? null;
    const where = anchor
        ? `\nOn ${anchor.path}${anchor.line === null ? '' : `:${anchor.line}`}` +
          `${anchor.lineType ? ` (${anchor.lineType.toLowerCase()})` : ''}`
        : '';
    const head = reply
        ? [
            `Bitbucket pull request #${view.pull.number}: reply by ${reply.author ?? 'unknown'}`,
            where,
            `In reply to ${comment.author ?? 'unknown'} (${comment.resolved ? 'thread resolved' : 'thread open'}):`,
            comment.text,
            '',
            'The reply:',
            reply.text,
            '',
        ]
        : [
            `Bitbucket pull request #${view.pull.number}: comment by ${comment.author ?? 'unknown'}`,
            where,
            `State: ${comment.resolved ? 'resolved' : 'open'}`,
            '',
            comment.text,
            '',
        ];
    const lines = [
        ...head,
        ...comment.replies.flatMap((entry) =>
            entry === reply ? [] : [`Reply by ${entry.author ?? 'unknown'}: ${entry.text}`, ''],
        ),
    ];
    let code = lines.join('\n');

    if (anchor) {
        const file = view.files.find((entry) => entry.path === anchor.path);
        if (file) {
            const rows = parseDiffRows(file.diffText);
            const anchorIndex = anchorRowIndex(rows, anchor);
            if (anchorIndex !== -1) {
                const window = rowsAsQuote(excerptAround(rows, anchorIndex));
                code = `${code}\n## Diff context around ${anchor.path}:${anchor.line ?? ''}\n${window}`;
            }
        }
    } else {
        code = `${code}\n\n${buildPullViewMaterial(view)}`;
    }

    const label = reply
        ? `Bitbucket PR #${view.pull.number}: reply by ${reply.author ?? 'unknown'}${anchor ? ` (${anchor.path})` : ''}`
        : anchor
            ? `Bitbucket PR #${view.pull.number}: comment by ${comment.author ?? 'unknown'} (${anchor.path})`
            : `Bitbucket PR #${view.pull.number}: comment by ${comment.author ?? 'unknown'}`;
    const line = anchor?.line ?? 0;
    return addQuoteDraft(label.slice(0, 120), code, 'markdown', line, line);
};
