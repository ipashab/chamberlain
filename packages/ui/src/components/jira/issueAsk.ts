import type { JiraIssueView } from '@/lib/jira/issue-view-api';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';
import { buildIssueLinksMaterial, buildIssueViewMaterial } from './issueViewMaterial';

export type IssueAskResult =
    | { ok: true }
    | { ok: false; reason: 'no-session' | 'rejected' };

/**
 * The one door every ask goes through: the current session pins the
 * quote to its next message, and a workable draft store accepts it.
 * Shared by the issue, the comment and the links, because the answer
 * never differs — only the label and the material do.
 *
 * Plain store reads, no i18n: the caller owns the words it answers with.
 */
const addQuoteDraft = (
    label: string,
    code: string,
    language: string,
    startLine: number,
    endLine: number,
): IssueAskResult => {
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
 * Pin one issue to the next message of the current session as a labeled
 * quote. The same flow the inline code comments use: the composer shows
 * the chip, the user asks the question, the material rides along.
 * Nothing is sent from here — the pin is a promise about the next
 * message.
 */
export const attachIssueAsk = (view: JiraIssueView): IssueAskResult => {
    const label = `Jira ${view.issue.key}: ${view.issue.summary}`.slice(0, 80);
    return addQuoteDraft(label, buildIssueViewMaterial(view), 'markdown', 0, 0);
};

/**
 * One comment — the author, the moment, the words — pinned for the next
 * message, with the issue's own material behind it: a question about the
 * note can see the note's subject. The author's words ride along
 * verbatim; nothing is sent from here.
 */
export const attachIssueCommentAsk = (
    view: JiraIssueView,
    comment: JiraIssueView['comments'][number],
): IssueAskResult => {
    const who = comment.author?.name ?? 'unknown';
    const lines = [
        `Jira ${view.issue.key}: comment by ${who}`,
        `Posted: ${comment.created ?? 'unknown time'}${comment.edited ? ' (edited)' : ''}`,
        '',
        comment.text,
        '',
    ];
    const label = `Jira ${view.issue.key}: comment by ${who}`.slice(0, 120);
    return addQuoteDraft(label, lines.join('\n'), 'markdown', 0, 0);
};

/**
 * The issue's relations — every link, every subtask, the epic — pinned
 * for the next message: the ask that aims at the graph rather than the
 * issue. Nothing is sent from here.
 */
export const attachIssueLinksAsk = (view: JiraIssueView): IssueAskResult => {
    const label = `Jira ${view.issue.key}: linked issues`.slice(0, 120);
    return addQuoteDraft(label, buildIssueLinksMaterial(view), 'markdown', 0, 0);
};
