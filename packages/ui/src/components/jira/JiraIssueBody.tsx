import React from 'react';
import DOMPurify, { type DOMPurify as DOMPurifyInstance } from 'dompurify';
import { toast } from 'sonner';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { openExternalUrl } from '@/lib/url';
import { formatDateTimeForPreference } from '@/lib/timeFormat';
import { useUIStore } from '@/stores/useUIStore';
import type { JiraIssueView } from '@/lib/jira/issue-view-api';
import {
    attachIssueAsk,
    attachIssueCommentAsk,
    attachIssueLinksAsk,
    type IssueAskResult,
} from './issueAsk';
import { useIssueSpec } from './useIssueSpec';
import type { IssueSpec } from './issueSpec';
import { JiraAvatar } from './JiraAvatar';

/**
 * Jira's rendered HTML narrowed to prose: the tags and attributes text
 * carries — paragraphs, lists, tables, links — and nothing more. No
 * images, no scripts, no classes: the instance is trusted, but the
 * viewer's walls do not move for anyone's markup.
 */
const SANITIZE_CONFIG = {
    ALLOWED_TAGS: [
        'a', 'b', 'blockquote', 'br', 'code', 'div', 'em', 'h1', 'h2', 'h3', 'h4',
        'h5', 'h6', 'hr', 'i', 'li', 'ol', 'p', 'pre', 's', 'span', 'strong',
        'sub', 'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'u', 'ul',
    ],
    ALLOWED_ATTR: ['href'],
};

/**
 * The issue view's own purifier, a local instance so the chat's sanitizer
 * and its hooks stay untouched. Every link the viewer keeps opens in the
 * user's browser, never inside the app; where no DOM can sanitize at all
 * the caller falls back to the wiki words.
 */
let purifier: DOMPurifyInstance | null = null;

const issuePurifier = (): DOMPurifyInstance | null => {
    if (purifier !== null) return purifier;
    // The default instance is unsupported exactly when there is no window.
    if (!DOMPurify.isSupported) return null;
    const instance = DOMPurify(window);
    if (!instance.isSupported) return null;
    instance.addHook('afterSanitizeAttributes', (node) => {
        if (!(node instanceof HTMLAnchorElement)) return;
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noreferrer');
    });
    purifier = instance;
    return instance;
};

/**
 * The HTML the instance rendered, sanitized to that prose — or null when
 * no DOM can sanitize, where the wiki words answer instead.
 */
const sanitizeRendered = (html: string): string | null => {
    const instance = issuePurifier();
    return instance === null ? null : instance.sanitize(html, SANITIZE_CONFIG);
};

/**
 * One sanitized render, mounted once per html string: the sanitize work
 * happens in a memo, so a re-render costs nothing but the DOM it owes.
 */
const SanitizedHtml: React.FC<{ html: string; className: string }> = ({ html, className }) => {
    const safe = React.useMemo(() => sanitizeRendered(html), [html]);
    if (safe === null) return null;
    return <div className={className} dangerouslySetInnerHTML={{ __html: safe }} />;
};

/**
 * The read view of one Jira issue, drawn close to the instance's own
 * page: a header — the key, the summary, the status chip, the people —
 * then the Details, the rendered Description, the Comments, the Issue
 * links, the Subtasks and the Attachments over what the server already
 * read, with "Ask about this issue" for the next message. One component
 * behind the context panel's Jira surface. Read-only everywhere: it
 * renders what the server fetched and writes nothing anywhere.
 */
export const JiraIssueBody: React.FC<{ view: JiraIssueView }> = ({ view }) => {
    const { t } = useI18n();
    const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);

    const formatStamp = (iso: string): string =>
        formatDateTimeForPreference(Date.parse(iso), timeFormatPreference, {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
        });

    // One answer for every ask's failure, because the ways they fail never
    // differ: without a session there is nothing to pin to, and a refused
    // quote is a refused quote, whichever surface asked.
    const reportAsk = (result: IssueAskResult): boolean => {
        if (!result.ok) {
            if (result.reason === 'no-session') toast.error(t('jiraView.askNoSession'));
            else toast.error(t('jiraView.askFailed'));
            return false;
        }
        toast.message(t('jiraView.askAttached'));
        return true;
    };

    const issue = view.issue;

    // The reading this issue asked for: its session, its answer, its card.
    const reading = useIssueSpec(view);
    const [specStarting, setSpecStarting] = React.useState(false);
    React.useEffect(() => {
        setSpecStarting(false);
    }, [issue.url]);

    // The reading starts in its own session; the panel only reports how the
    // starting went, in the two ways it can fail: nowhere to run, no model.
    const startSpec = async () => {
        if (specStarting) return;
        setSpecStarting(true);
        const result = await reading.start();
        setSpecStarting(false);
        if (!result.ok) {
            if (result.reason === 'no-model') toast.error(t('jiraView.specNoModel'));
            else toast.error(t('jiraView.specFailed'));
            return;
        }
        toast.message(t('jiraView.specStarted'));
    };

    /** The spec card: the reading's answer as a card, not prose to parse. */
    const SpecCard: React.FC<{ spec: IssueSpec }> = ({ spec: card }) => (
        <section className="space-y-1.5 rounded-lg border border-border px-3 py-2">
            <div className="flex items-center justify-between gap-2">
                <h4 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {t('jiraView.specCardTitle')}
                </h4>
                {reading.entry !== null ? (
                    <Button type="button" variant="ghost" size="xs" onClick={reading.openSession}>
                        {t('jiraView.specOpenSession')}
                    </Button>
                ) : null}
            </div>
            <p className="text-[13px] leading-relaxed">{card.essence}</p>
            {card.plan.length > 0 ? (
                <div className="space-y-0.5">
                    <span className="text-[11px] font-medium text-muted-foreground">
                        {t('jiraView.specPlan')}
                    </span>
                    <ul className="list-disc space-y-0.5 pl-5">
                        {card.plan.map((item) => (
                            <li key={item} className="break-words text-[12px] leading-relaxed">{item}</li>
                        ))}
                    </ul>
                </div>
            ) : null}
            {card.acceptance.length > 0 ? (
                <div className="space-y-0.5">
                    <span className="text-[11px] font-medium text-muted-foreground">
                        {t('jiraView.specAcceptance')}
                    </span>
                    <ul className="list-disc space-y-0.5 pl-5">
                        {card.acceptance.map((item) => (
                            <li key={item} className="break-words text-[12px] leading-relaxed">{item}</li>
                        ))}
                    </ul>
                </div>
            ) : null}
            {card.openQuestions.length > 0 ? (
                <div className="space-y-0.5">
                    <span className="text-[11px] font-medium text-muted-foreground">
                        {t('jiraView.specQuestions')}
                    </span>
                    <ul className="list-disc space-y-0.5 pl-5">
                        {card.openQuestions.map((item) => (
                            <li key={item} className="break-words text-[12px] leading-relaxed">{item}</li>
                        ))}
                    </ul>
                </div>
            ) : null}
            {card.outOfScope.length > 0 ? (
                <div className="space-y-0.5">
                    <span className="text-[11px] font-medium text-muted-foreground">
                        {t('jiraView.specOutOfScope')}
                    </span>
                    <ul className="list-disc space-y-0.5 pl-5">
                        {card.outOfScope.map((item) => (
                            <li key={item} className="break-words text-[12px] leading-relaxed">{item}</li>
                        ))}
                    </ul>
                </div>
            ) : null}
        </section>
    );

    const statusColorOf = (category: string | null | undefined): string => {
        if (category === 'done') return 'var(--status-success)';
        if (category === 'indeterminate') return 'var(--status-warning)';
        return 'var(--status-info)';
    };

    const Chip: React.FC<{ color: string; children: React.ReactNode; className?: string }> = ({ color, children, className }) => (
        <span
            className={`inline-flex shrink-0 items-center rounded-full px-1.5 text-[10px] font-medium leading-4 ${className ?? ''}`}
            style={{
                color,
                backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`,
            }}
        >
            {children}
        </span>
    );

    const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
        <div className="flex items-baseline gap-2 py-0.5">
            <span className="w-28 shrink-0 truncate text-[11px] text-muted-foreground">{label}</span>
            <span className="min-w-0 flex-1 break-words text-[12px]">{children}</span>
        </div>
    );

    const descriptionHtml = React.useMemo(
        () => (view.description.html ? sanitizeRendered(view.description.html) : null),
        [view.description.html],
    );
    const sprints = issue.sprints ?? [];
    const sprintsShown = sprints.slice(0, 2);
    const sprintsHidden = Math.max(0, sprints.length - sprintsShown.length);

    return (
        <div className="space-y-4">
            <header className="space-y-1.5">
                <h3 className="text-[15px] font-semibold leading-tight break-words">
                    {issue.summary}{' '}
                    <a
                        href={issue.url}
                        onClick={(event) => {
                            event.preventDefault();
                            void openExternalUrl(issue.url);
                        }}
                        className="font-normal text-muted-foreground underline-offset-2 hover:underline"
                        aria-label={t('jiraView.openExternal')}
                    >
                        {issue.key}
                    </a>
                </h3>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted-foreground">
                    {issue.status.name ? (
                        <Chip color={statusColorOf(issue.status.category)}>{issue.status.name}</Chip>
                    ) : null}
                    {issue.type.name ? <span>{issue.type.name}</span> : null}
                    {issue.priority.name ? <span>·</span> : null}
                    {issue.priority.name ? <span>{issue.priority.name}</span> : null}
                    {issue.resolution ? (
                        <>
                            <span>·</span>
                            <span>{issue.resolution}</span>
                        </>
                    ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted-foreground">
                    {issue.assignee ? (
                        <>
                            <JiraAvatar name={issue.assignee.name} imagePath={issue.assignee.avatarPath} />
                            <span>{t('jiraView.fieldAssignee')}: </span>
                            <span className="font-medium text-foreground">{issue.assignee.name ?? '—'}</span>
                        </>
                    ) : null}
                    {issue.reporter ? (
                        <>
                            <span>·</span>
                            <span>{t('jiraView.fieldReporter')}: {issue.reporter.name ?? '—'}</span>
                        </>
                    ) : null}
                </div>
                {issue.created || issue.updated ? (
                    <div className="text-[11px] text-muted-foreground">
                        {issue.created ? `${t('jiraView.fieldCreated')} ${formatStamp(issue.created)}` : null}
                        {issue.created && issue.updated ? ' · ' : null}
                        {issue.updated ? `${t('jiraView.fieldUpdated')} ${formatStamp(issue.updated)}` : null}
                    </div>
                ) : null}
            </header>

            <div className="flex flex-wrap items-center gap-2">
                <Button type="button" size="sm" onClick={() => reportAsk(attachIssueAsk(view))}>
                    {t('jiraView.ask')}
                </Button>
                <Button type="button" size="sm" variant="outline" disabled={specStarting || reading.reading} onClick={() => void startSpec()}>
                    <Icon name="file-text" className="size-3.5 shrink-0" />
                    {t('jiraView.specCompose')}
                </Button>
                <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => void openExternalUrl(issue.url)}
                >
                    <Icon name="external-link" className="size-3.5 shrink-0" />
                    {t('jiraView.openExternal')}
                </Button>
            </div>

            {reading.reading ? (
                <p className="text-[13px] text-muted-foreground">{t('jiraView.specReading')}</p>
            ) : null}
            {reading.spec !== null ? <SpecCard spec={reading.spec} /> : null}

            <section className="rounded-lg border border-border px-3 py-2">
                <h4 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {t('jiraView.sectionDetails')}
                </h4>
                <div className="mt-1.5">
                    {issue.assignee === null ? (
                        <Row label={t('jiraView.fieldAssignee')}>—</Row>
                    ) : null}
                    {issue.reporter === null ? (
                        <Row label={t('jiraView.fieldReporter')}>—</Row>
                    ) : null}
                    {issue.labels.length > 0 ? (
                        <Row label={t('jiraView.fieldLabels')}>
                            {issue.labels.map((label) => (
                                <Chip key={label} color="var(--muted-foreground)" className="mr-1">
                                    {label}
                                </Chip>
                            ))}
                        </Row>
                    ) : null}
                    {issue.components.length > 0 ? (
                        <Row label={t('jiraView.fieldComponents')}>{issue.components.join(', ')}</Row>
                    ) : null}
                    {issue.epic ? (
                        <Row label={t('jiraView.fieldEpic')}>
                            <Chip color="var(--status-success)">
                                {issue.epic.name ?? issue.epic.key}
                            </Chip>
                        </Row>
                    ) : null}
                    {sprintsShown.length > 0 ? (
                        <Row label={t('jiraView.fieldSprint')}>
                            {sprintsShown.map((sprint) => (
                                <Chip key={sprint} color="var(--status-info)" className="mr-1">
                                    {sprint}
                                </Chip>
                            ))}
                            {sprintsHidden > 0 ? (
                                <span title={sprints.join(', ')}>
                                    {t('jiraView.sprintsOverflow', { count: sprintsHidden })}
                                </span>
                            ) : null}
                        </Row>
                    ) : null}
                    {issue.watchCount !== null ? (
                        <Row label={t('jiraView.fieldWatchers')}>{issue.watchCount}</Row>
                    ) : null}
                    {issue.customFields.map((field) => (
                        <Row key={field.id} label={field.name}>{field.text}</Row>
                    ))}
                </div>
            </section>

            {descriptionHtml !== null || view.description.wiki ? (
                <section className="space-y-1.5">
                    <h4 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                        {t('jiraView.sectionDescription')}
                    </h4>
                    {descriptionHtml !== null ? (
                        <div
                            className="jira-rendered break-words text-[13px] leading-relaxed [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-2 [&_code]:font-mono [&_code]:text-[12px] [&_h1]:mt-3 [&_h1]:text-[13px] [&_h1]:font-semibold [&_h2]:mt-3 [&_h2]:text-[13px] [&_h2]:font-semibold [&_h3]:mt-2 [&_h3]:font-semibold [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1 [&_pre]:my-1 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-[var(--surface-muted)] [&_pre]:p-2 [&_pre]:font-mono [&_pre]:text-[12px] [&_table]:my-2 [&_td]:border [&_td]:border-border [&_td]:px-1.5 [&_th]:border [&_th]:border-border [&_th]:px-1.5 [&_ul]:list-disc [&_ul]:pl-5"
                            // The HTML here is DOMPurify's output of the
                            // instance's own render, narrowed to prose tags
                            // and hrefs — the one place rendered HTML mounts.
                            dangerouslySetInnerHTML={{ __html: descriptionHtml }}
                        />
                    ) : (
                        <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed">
                            {view.description.wiki}
                        </p>
                    )}
                </section>
            ) : null}

            <section className="space-y-1.5">
                <h4 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {t('jiraView.sectionComments', { count: view.comments.length })}
                </h4>
                {view.comments.length === 0 ? (
                    <p className="text-[12px] text-muted-foreground">{t('jiraView.commentsEmpty')}</p>
                ) : (
                    <div className="space-y-3">
                        {view.comments.map((comment) => (
                            <div key={comment.id ?? comment.created} className="space-y-1">
                                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
                                    <JiraAvatar name={comment.author?.name} imagePath={comment.author?.avatarPath} />
                                    <span className="font-medium text-foreground">
                                        {comment.author?.name ?? '—'}
                                    </span>
                                    {comment.created ? <span className="text-muted-foreground">{formatStamp(comment.created)}</span> : null}
                                    {comment.edited ? (
                                        <span className="text-[10px] text-muted-foreground">
                                            ({t('jiraView.edited')} {comment.updated ? formatStamp(comment.updated) : ''})
                                        </span>
                                    ) : null}
                                    <button
                                        type="button"
                                        aria-label={t('jiraView.commentAsk')}
                                        className="shrink-0 text-muted-foreground hover:text-foreground"
                                        onClick={() => reportAsk(attachIssueCommentAsk(view, comment))}
                                    >
                                        <Icon name="chat-4" className="size-3.5" />
                                    </button>
                                </div>
                                {comment.html ? (
                                    <SanitizedHtml
                                        className="jira-rendered break-words pl-6 text-[13px] leading-relaxed [&_a]:underline [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1 [&_ul]:list-disc [&_ul]:pl-5"
                                        html={comment.html}
                                    />
                                ) : comment.text ? (
                                    <p className="whitespace-pre-wrap break-words pl-6 text-[13px] leading-relaxed">
                                        {comment.text}
                                    </p>
                                ) : null}
                            </div>
                        ))}
                        {view.truncated.comments ? (
                            <p className="text-[12px] text-muted-foreground">{t('jiraView.commentsTruncated')}</p>
                        ) : null}
                    </div>
                )}
            </section>

            {view.issueLinks.length > 0 || view.subtasks.length > 0 ? (
                <section className="space-y-1.5">
                    <div className="flex items-center justify-between">
                        <h4 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                            {view.subtasks.length > 0 && view.issueLinks.length === 0
                                ? t('jiraView.sectionSubtasks')
                                : t('jiraView.sectionLinks')}
                        </h4>
                        {view.issueLinks.length > 0 ? (
                            <Button
                                type="button"
                                variant="ghost"
                                size="xs"
                                onClick={() => reportAsk(attachIssueLinksAsk(view))}
                            >
                                {t('jiraView.linksAsk')}
                            </Button>
                        ) : null}
                    </div>
                    <div className="space-y-1">
                        {view.issueLinks.map((link) => (
                            <div key={`${link.typeName ?? ''}-${link.issue.key}`} className="flex items-center gap-2 text-[12px]">
                                <span className="shrink-0 text-muted-foreground">
                                    {link.relation ?? link.typeName ?? ''}:
                                </span>
                                <span className="shrink-0 font-medium">{link.issue.key}</span>
                                <span className="min-w-0 flex-1 truncate">{link.issue.summary ?? ''}</span>
                                {link.issue.statusName ? (
                                    <Chip
                                        color="var(--muted-foreground)"
                                        className="shrink-0"
                                    >
                                        {link.issue.statusName}
                                    </Chip>
                                ) : null}
                            </div>
                        ))}
                        {view.subtasks.map((subtask) => (
                            <div key={subtask.key} className="flex items-center gap-2 text-[12px]">
                                <span className="shrink-0 text-muted-foreground">{t('jiraView.sectionSubtasks')}:</span>
                                <span className="shrink-0 font-medium">{subtask.key}</span>
                                <span className="min-w-0 flex-1 truncate">{subtask.summary ?? ''}</span>
                                {subtask.statusName ? (
                                    <Chip color="var(--muted-foreground)" className="shrink-0">
                                        {subtask.statusName}
                                    </Chip>
                                ) : null}
                            </div>
                        ))}
                    </div>
                </section>
            ) : null}

            {view.attachments.length > 0 ? (
                <section className="space-y-1.5">
                    <h4 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                        {t('jiraView.sectionAttachments')}
                    </h4>
                    <div className="space-y-0.5">
                        {view.attachments.map((attachment) => (
                            <div key={attachment.id ?? attachment.filename} className="flex items-center gap-2 text-[12px]">
                                <Icon name="attachment-2" className="size-3.5 shrink-0 text-muted-foreground" />
                                <span className="min-w-0 flex-1 truncate">{attachment.filename ?? '—'}</span>
                                {attachment.size !== null && attachment.size !== undefined ? (
                                    <span className="shrink-0 text-muted-foreground">
                                        {Math.max(1, Math.round(attachment.size / 1024))} KB
                                    </span>
                                ) : null}
                                {attachment.author ? (
                                    <span className="shrink-0 text-muted-foreground">{attachment.author}</span>
                                ) : null}
                            </div>
                        ))}
                    </div>
                </section>
            ) : null}
        </div>
    );
};
