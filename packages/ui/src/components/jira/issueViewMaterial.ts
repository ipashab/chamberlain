// The Jira issue as text, for the "ask about this issue" flow.
//
// The viewer already renders the view from the server's one read; this
// module turns the same view into the material the chat carries: the
// pinned context quote behind the composer chip. Everything is assembled
// locally from what was read — the instance never hears about it.
//
// The cap keeps one issue from crowding the message: the material ends
// with an explicit truncation note, so the reader knows the cut happened
// and can ask for the rest by opening the view again.

import type { JiraIssueView } from '@/lib/jira/issue-view-api';

const MATERIAL_CAP = 48_000;

const stampOf = (iso: string | null | undefined): string => {
    const value = iso ? Date.parse(iso) : Number.NaN;
    return Number.isFinite(value) ? new Date(value).toISOString() : 'unknown time';
};

const sizeWord = (bytes: number | null | undefined): string =>
    bytes === null || bytes === undefined ? 'unknown size' : `${Math.max(1, Math.round(bytes / 1024))} KB`;

const metaOf = (view: JiraIssueView): string => [
    view.issue.type.name ? `Type: ${view.issue.type.name}` : null,
    view.issue.status.name ? `Status: ${view.issue.status.name}` : null,
    view.issue.resolution ? `Resolution: ${view.issue.resolution}` : null,
    view.issue.priority.name ? `Priority: ${view.issue.priority.name}` : null,
    view.issue.assignee?.name ? `Assignee: ${view.issue.assignee.name}` : null,
    view.issue.reporter?.name ? `Reporter: ${view.issue.reporter.name}` : null,
].filter((part) => part !== null).join(' · ');

const datesOf = (view: JiraIssueView): string[] => [
    view.issue.created ? `Created: ${stampOf(view.issue.created)}` : null,
    view.issue.updated ? `Updated: ${stampOf(view.issue.updated)}` : null,
].filter((part): part is string => part !== null);

const detailLines = (view: JiraIssueView): string[] => {
    const rows: Array<[string, string | null]> = [];
    if (view.issue.customFields.length > 0) {
        rows.push(...view.issue.customFields.map((field): [string, string | null] => [field.name, field.text]));
    }
    if (view.issue.epic) {
        rows.push([
            'Epic',
            view.issue.epic.name === null ? view.issue.epic.key : `${view.issue.epic.key} ${view.issue.epic.name}`,
        ]);
    }
    if (view.issue.sprints !== null && view.issue.sprints !== undefined && view.issue.sprints.length > 0) {
        rows.push(['Sprints', view.issue.sprints.join(', ')]);
    }
    if (view.issue.labels.length > 0) rows.push(['Labels', view.issue.labels.join(', ')]);
    if (view.issue.components.length > 0) rows.push(['Components', view.issue.components.join(', ')]);
    if (view.issue.watchCount !== null) {
        const watcherNames = view.issue.watcherNames;
        rows.push([
            'Watchers',
            watcherNames && watcherNames.length > 0
                ? `${view.issue.watchCount} (${watcherNames.join(', ')})`
                : String(view.issue.watchCount),
        ]);
    }
    if (rows.length === 0) return [];
    return ['## Details', ...rows.map(([label, value]) => `- ${label}: ${value ?? '—'}`), ''];
};

const commentLines = (view: JiraIssueView): string[] => {
    if (view.comments.length === 0) return [];
    const lines = [`## Comments (${view.comments.length})`];
    for (const comment of view.comments) {
        const who = comment.author?.name ?? 'unknown';
        lines.push(`### ${who} — ${stampOf(comment.created)}${comment.edited ? ' (edited)' : ''}`);
        lines.push(comment.text);
        lines.push('');
    }
    return lines;
};

const linkLines = (view: JiraIssueView): string[] => {
    const linkRows = view.issueLinks.map((link) => linkRowOf(link));
    const subtaskRows = view.subtasks.map((subtask) => subtaskRowOf(subtask));
    if (linkRows.length === 0 && subtaskRows.length === 0) return [];
    const lines = ['## Linked issues'];
    if (linkRows.length > 0) lines.push(...linkRows);
    if (subtaskRows.length > 0) {
        lines.push('Subtasks:');
        lines.push(...subtaskRows);
    }
    lines.push('');
    return lines;
};

const linkRowOf = (link: JiraIssueView['issueLinks'][number]): string => {
    const relation = link.relation ?? link.typeName ?? 'related to';
    const status = link.issue.statusName === null ? '' : ` (${link.issue.statusName})`;
    const summary = link.issue.summary === null ? '' : ` ${link.issue.summary}`;
    return `- ${relation} ${link.issue.key}${status}:${summary}`;
};

const subtaskRowOf = (subtask: JiraIssueView['subtasks'][number]): string => {
    const status = subtask.statusName === null ? '' : ` (${subtask.statusName})`;
    const summary = subtask.summary === null ? '' : ` ${subtask.summary}`;
    return `- ${subtask.key}${status}:${summary}`;
};

const attachmentLines = (view: JiraIssueView): string[] => {
    if (view.attachments.length === 0) return [];
    return [
        '## Attachments',
        ...view.attachments.map((attachment) =>
            `- ${attachment.filename ?? 'unnamed'} — ${sizeWord(attachment.size)}${attachment.author ? ` by ${attachment.author}` : ''}`),
        '',
    ];
};

/**
 * The whole issue as markdown. The meta leads — the reader knows what it
 * is before the bulk — then the details, the description, the linked
 * issues, the comments and the attachments. The description rides as the
 * wiki markup the instance stores: the words themselves, not the HTML
 * that merely clothes them.
 */
export const buildIssueViewMaterial = (view: JiraIssueView): string => {
    const issue = view.issue;
    const head = [
        `Jira issue ${issue.key}: ${issue.summary}`,
        `URL: ${issue.url}`,
        metaOf(view),
        ...datesOf(view),
        '',
    ];

    const description = view.description.wiki
        ? ['## Description', view.description.wiki, '']
        : [];

    const body = [
        ...head,
        ...detailLines(view),
        ...description,
        ...linkLines(view),
        ...commentLines(view),
        ...attachmentLines(view),
    ];

    const text = body.join('\n');
    if (text.length <= MATERIAL_CAP) {
        return view.truncated.comments
            ? `${text}\n\n(Older comments stayed on the Jira side.)`
            : text;
    }
    return `${text.slice(0, MATERIAL_CAP)}\n\n(The material was cut to fit the message; open the issue view again for the rest.)`;
};

/**
 * The issue's links and subtasks alone, for the ask that aims at the
 * graph rather than the issue: every relation the view read, spelled as
 * the issue's own sidebar spells them.
 */
export const buildIssueLinksMaterial = (view: JiraIssueView): string => {
    const head = [
        `Linked issues of Jira ${view.issue.key}: ${view.issue.summary}`,
        view.issue.epic
            ? `Epic: ${view.issue.epic.name === null ? view.issue.epic.key : `${view.issue.epic.key} ${view.issue.epic.name}`}`
            : null,
        '',
    ].filter((part): part is string => part !== null);

    const body = [...head, ...linkLines(view)];
    return body.join('\n').trimEnd();
};
