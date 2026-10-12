import type { BitbucketPullView } from '@/lib/bitbucket/pull-view-api';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';
import { excerptAround, type DiffRow } from '@/lib/bitbucket/pullDiff';
import { buildPullViewMaterial } from './pullViewMaterial';

export type PullAskResult =
    | { ok: true }
    | { ok: false; reason: 'no-session' | 'rejected' };

/**
 * Pin one pull request to the next message of the current session as a
 * labeled quote. The same flow the inline code comments use: the composer
 * shows the chip, the user asks the question, the material rides along.
 * Nothing is sent from here — the pin is a promise about the next message.
 *
 * Plain store reads, no i18n: the caller owns the words it answers with.
 */
export const attachPullAsk = (view: BitbucketPullView): PullAskResult => {
    const { currentSessionId, getDirectoryForSession } = useSessionUIStore.getState();
    const directory = currentSessionId ? getDirectoryForSession(currentSessionId) : null;
    if (!currentSessionId || !directory) {
        return { ok: false, reason: 'no-session' };
    }
    const label = `Bitbucket PR #${view.pull.number}: ${view.pull.title}`.slice(0, 80);
    const accepted = useInlineCommentDraftStore.getState().addDraft(
        { directory, sessionKey: currentSessionId },
        {
            source: 'file-quote',
            fileLabel: label,
            startLine: 0,
            endLine: 0,
            code: buildPullViewMaterial(view),
            language: 'markdown',
            text: '',
        },
    );
    return accepted === null ? { ok: false, reason: 'rejected' } : { ok: true };
};

/**
 * One diff line of one pull, pinned for the next message the same way the
 * whole pull is: the label names the file and the line, the code carries
 * the hunk window the line lives in — numbered rows so the reader can see
 * where the line sits — and the user writes the question in the composer.
 * Nothing is sent from here, and the material stays inside the hunk: a
 * question about one line does not need the whole pull to answer it.
 */
export const attachLineAsk = (
    view: BitbucketPullView,
    file: { path: string },
    rows: readonly DiffRow[],
    lineIndex: number,
): PullAskResult => {
    const row = rows[lineIndex];
    if (!row || row.oldLine === null && row.newLine === null) {
        return { ok: false, reason: 'rejected' };
    }
    const { currentSessionId, getDirectoryForSession } = useSessionUIStore.getState();
    const directory = currentSessionId ? getDirectoryForSession(currentSessionId) : null;
    if (!currentSessionId || !directory) {
        return { ok: false, reason: 'no-session' };
    }
    const lineRef = row.newLine ?? row.oldLine;
    if (lineRef === null) {
        return { ok: false, reason: 'rejected' };
    }
    const label = `Bitbucket PR #${view.pull.number}: ${file.path}:${lineRef}`.slice(0, 120);
    const code = excerptAround(rows, lineIndex)
        .map((entry) => {
            const number = entry.newLine ?? entry.oldLine;
            return number === null ? entry.text : `${String(number).padStart(4, ' ')}| ${entry.text}`;
        })
        .join('\n');
    const accepted = useInlineCommentDraftStore.getState().addDraft(
        { directory, sessionKey: currentSessionId },
        {
            source: 'file-quote',
            fileLabel: label,
            startLine: lineRef,
            endLine: lineRef,
            code,
            language: '',
            text: '',
        },
    );
    return accepted === null ? { ok: false, reason: 'rejected' } : { ok: true };
};
