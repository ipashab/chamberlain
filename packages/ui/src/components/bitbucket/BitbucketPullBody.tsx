import React from 'react';
import { toast } from 'sonner';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { useI18n } from '@/lib/i18n';
import { openExternalUrl } from '@/lib/url';
import { formatDateTimeForPreference } from '@/lib/timeFormat';
import { useUIStore } from '@/stores/useUIStore';
import type { BitbucketPullView } from '@/lib/bitbucket/pull-view-api';
import { attachLineAsk, attachPullAsk } from './pullAsk';
import { BitbucketAvatar } from './BitbucketAvatar';
import { parseDiffRows, type DiffRow } from '@/lib/bitbucket/pullDiff';

type PullTab = 'overview' | 'activity' | 'commits' | 'changes';

/**
 * The read view of one Bitbucket pull request, drawn close to the
 * instance's own PR page: a header — title, author with the avatar circle
 * DC falls back to, the state and checks chips, the branch line — then
 * the Overview, Activity, Commits and Changes tabs over what the server
 * already read: description, reviewers, comments, commits and files with
 * their unified diffs, and the actions — "Ask about this pull request"
 * and the external link. One component behind the two doors that open
 * it: the task details dialog and the context panel's dedicated surface.
 * Read-only everywhere: it renders what the server fetched and writes
 * nothing anywhere.
 */
export const BitbucketPullBody: React.FC<{ view: BitbucketPullView }> = ({ view }) => {
    const { t } = useI18n();
    const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
    const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(new Set());
    const [tab, setTab] = React.useState<PullTab>('overview');

    React.useEffect(() => {
        setTab('overview');
    }, [view.pull.url]);

    const ask = () => {
        const result = attachPullAsk(view);
        if (!result.ok) {
            if (result.reason === 'no-session') toast.error(t('chat.workStatus.teamBoard.pullView.askNoSession'));
            else toast.error(t('chat.workStatus.teamBoard.pullView.askFailed'));
            return;
        }
        toast.message(t('chat.workStatus.teamBoard.pullView.askAttached'));
    };

    const stateColorOf = (state: string): string | null => {
        if (state === 'merged') return 'var(--status-success)';
        if (state === 'closed') return 'var(--muted-foreground)';
        if (state === 'open') return 'var(--status-info)';
        return null;
    };

    const checksColorOf = (checks: BitbucketPullView['pull']['checks']): string | null => {
        if (!checks) return null;
        if (checks.state === 'failure') return 'var(--status-error)';
        if (checks.state === 'pending') return 'var(--status-warning)';
        if (checks.state === 'success') return 'var(--status-success)';
        return 'var(--muted-foreground)';
    };

    const checksLabelOf = (checks: BitbucketPullView['pull']['checks']): string => {
        if (!checks) return t('chat.workStatus.teamBoard.pullView.noChecks');
        if (checks.state === 'failure') return t('chat.workStatus.teamBoard.pull.ciFailing');
        if (checks.state === 'pending') return t('chat.workStatus.teamBoard.pull.ciPending');
        if (checks.state === 'success') return t('chat.workStatus.teamBoard.pull.ciPassing');
        return t('chat.workStatus.teamBoard.pullView.noChecks');
    };

    const formatStamp = (timestamp: number): string =>
        formatDateTimeForPreference(timestamp, timeFormatPreference, {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
        });

    const toggleFile = (path: string) => {
        setExpanded((previous) => {
            const next = new Set(previous);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
        });
    };

    const pull = view.pull;

    const tabs: Array<{ id: PullTab; label: string }> = [
        { id: 'overview', label: t('chat.workStatus.teamBoard.pullView.tabOverview') },
        { id: 'activity', label: t('chat.workStatus.teamBoard.pullView.comments', { count: view.comments.length }) },
        { id: 'commits', label: t('chat.workStatus.teamBoard.pullView.commits', { count: view.commits.length }) },
        { id: 'changes', label: t('chat.workStatus.teamBoard.pullView.tabChanges', { count: view.files.length }) },
    ];

    return (
        <div className="space-y-4">
            <header className="space-y-1.5">
                <h3 className="text-[15px] font-semibold leading-tight break-words">
                    {pull.title}{' '}
                    <span className="font-normal text-muted-foreground">#{pull.number}</span>
                </h3>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted-foreground">
                    <BitbucketAvatar name={pull.author} slug={pull.authorSlug} />
                    <span className="font-medium text-foreground">{pull.author ?? '—'}</span>
                    <span>{t('chat.workStatus.teamBoard.pullView.wrote')}</span>
                    {pull.createdAt ? <span>{formatStamp(pull.createdAt)}</span> : null}
                    <span
                        className="inline-flex items-center rounded-full px-1.5 text-[10px] font-medium leading-4"
                        style={{
                            color: stateColorOf(pull.state) ?? 'var(--muted-foreground)',
                            backgroundColor: `color-mix(in srgb, ${stateColorOf(pull.state) ?? 'var(--muted-foreground)'} 12%, transparent)`,
                        }}
                    >
                        {t(`chat.workStatus.teamBoard.pull.${pull.state}`)}
                    </span>
                    {pull.checks ? (
                        <span
                            className="inline-flex items-center gap-1 rounded-full px-1.5 text-[10px] font-medium leading-4"
                            style={{
                                color: checksColorOf(pull.checks) ?? undefined,
                                backgroundColor: `color-mix(in srgb, ${checksColorOf(pull.checks) ?? 'var(--muted-foreground)'} 12%, transparent)`,
                            }}
                        >
                            {checksLabelOf(pull.checks)}
                        </span>
                    ) : null}
                </div>
                {pull.fromBranch && pull.toBranch ? (
                    <div className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
                        <Icon name="git-branch" className="size-3.5 shrink-0" />
                        <span className="min-w-0 truncate">{pull.fromBranch}</span>
                        <Icon name="arrow-right-s" className="size-3.5 shrink-0" />
                        <span className="min-w-0 truncate">{pull.toBranch}</span>
                    </div>
                ) : null}
            </header>

            <div className="flex flex-wrap items-center gap-2">
                <Button type="button" size="sm" onClick={ask}>
                    {t('chat.workStatus.teamBoard.pullView.ask')}
                </Button>
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => void openExternalUrl(pull.url)}
                >
                    {t('chat.workStatus.teamBoard.taskDetails.openPull')}
                </Button>
            </div>

            <div className="flex gap-1 border-b border-border" role="tablist">
                {tabs.map((entry) => (
                    <button
                        key={entry.id}
                        type="button"
                        role="tab"
                        aria-selected={tab === entry.id}
                        onClick={() => setTab(entry.id)}
                        className="-mb-px border-b-2 px-2 py-1.5 text-[12px]"
                        style={{
                            borderColor: tab === entry.id ? 'var(--interactive.selection)' : 'transparent',
                            color: tab === entry.id ? 'var(--surface.foreground)' : 'var(--surface.mutedForeground)',
                        }}
                    >
                        {entry.label}
                    </button>
                ))}
            </div>

            {tab === 'overview' ? (
                <div className="space-y-4">
                    {pull.description ? (
                        <section className="space-y-1.5">
                            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                                {t('chat.workStatus.teamBoard.pullView.description')}
                            </div>
                            <div className="rounded-lg border border-border bg-[var(--surface-muted)]/40 px-2.5 py-2">
                                <SimpleMarkdownRenderer content={pull.description} disableLinkSafety variant="tool" enableFileReferences={false} />
                            </div>
                        </section>
                    ) : null}

                    {pull.reviewers.length > 0 ? (
                        <section className="space-y-1.5">
                            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                                {t('chat.workStatus.teamBoard.pullView.reviewers')}
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                                {pull.reviewers.map((reviewer) => (
                                    <span
                                        key={reviewer.slug ?? reviewer.name ?? 'unknown'}
                                        className="inline-flex items-center gap-1 rounded-full px-1.5 text-[11px]"
                                        style={{
                                            color: reviewer.approved ? 'var(--status-success)' : 'var(--muted-foreground)',
                                            backgroundColor: `color-mix(in srgb, ${reviewer.approved ? 'var(--status-success)' : 'var(--muted-foreground)'} 12%, transparent)`,
                                        }}
                                    >
                                        {reviewer.name ?? reviewer.slug}
                                        {reviewer.approved ? <Icon name="check" className="size-3" /> : null}
                                    </span>
                                ))}
                            </div>
                        </section>
                    ) : null}
                </div>
            ) : null}

            {tab === 'activity' ? (
                <div className="space-y-3">
                    {view.truncated.comments ? (
                        <p className="text-[11px] text-muted-foreground">
                            {t('chat.workStatus.teamBoard.pullView.truncatedComments')}
                        </p>
                    ) : null}
                    {view.comments.length === 0 ? (
                        <p className="text-[13px] text-muted-foreground">
                            {t('chat.workStatus.teamBoard.pullView.emptyActivity')}
                        </p>
                    ) : (
                        <div className="space-y-2">
                            {view.comments.map((comment) => (
                                <div key={comment.id} className="rounded-lg border border-border px-2.5 py-2">
                                    <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                                        <BitbucketAvatar name={comment.author} slug={comment.authorSlug} />
                                        <span className="font-medium text-foreground">{comment.author ?? '—'}</span>
                                        {comment.createdAt ? <span>{formatStamp(comment.createdAt)}</span> : null}
                                        {comment.resolved ? (
                                            <span className="rounded-full px-1.5 text-[10px] font-medium" style={{ color: 'var(--status-success)' }}>
                                                {t('chat.workStatus.teamBoard.pullView.resolved')}
                                            </span>
                                        ) : null}
                                    </div>
                                    <SimpleMarkdownRenderer content={comment.text} disableLinkSafety variant="tool" enableFileReferences={false} />
                                    {comment.replies.map((reply, index) => (
                                        <div key={`${comment.id}-${index}`} className="ml-3 mt-1 border-l border-border pl-2">
                                            <span className="text-[11px] font-medium text-foreground">{reply.author ?? '—'}</span>
                                            <span className="ml-2 text-[11px] text-muted-foreground">
                                                {reply.createdAt ? formatStamp(reply.createdAt) : ''}
                                            </span>
                                            <SimpleMarkdownRenderer content={reply.text} disableLinkSafety variant="tool" enableFileReferences={false} />
                                        </div>
                                    ))}
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            ) : null}

            {tab === 'commits' ? (
                <div className="space-y-3">
                    {view.truncated.commits ? (
                        <p className="text-[11px] text-muted-foreground">
                            {t('chat.workStatus.teamBoard.pullView.truncatedCommits')}
                        </p>
                    ) : null}
                    {view.commits.length === 0 ? (
                        <p className="text-[13px] text-muted-foreground">
                            {t('chat.workStatus.teamBoard.pullView.emptyCommits')}
                        </p>
                    ) : (
                        <div className="space-y-1">
                            {view.commits.map((commit) => (
                                <div
                                    key={commit.sha}
                                    className="flex items-center gap-2 rounded-lg border border-border px-2.5 py-1.5"
                                >
                                    <BitbucketAvatar name={commit.author} />
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate text-[12px]">{commit.summary ?? commit.sha}</span>
                                        <span className="block truncate text-[11px] text-muted-foreground">
                                            {commit.author ?? '—'}
                                            {commit.date ? <> · {formatStamp(commit.date)}</> : null}
                                        </span>
                                    </span>
                                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                                        {commit.shortSha}
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            ) : null}

            {tab === 'changes' ? (
                <div className="space-y-3">
                    {view.truncated.diff ? (
                        <p className="text-[11px] text-muted-foreground">
                            {t('chat.workStatus.teamBoard.pullView.truncatedDiff')}
                        </p>
                    ) : null}
                    {view.files.length === 0 ? (
                        <p className="text-[13px] text-muted-foreground">
                            {t('chat.workStatus.teamBoard.pullView.emptyChanges')}
                        </p>
                    ) : (
                        <div className="space-y-1">
                            {view.files.map((file, index) => (
                                <div key={`${file.path}-${index}`} className="rounded-lg border border-border">
                                    <button
                                        type="button"
                                        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-[12px]"
                                        onClick={() => toggleFile(file.path)}
                                    >
                                        <Icon
                                            name={expanded.has(file.path) ? 'arrow-down-s' : 'arrow-right-s'}
                                            className="size-3.5 shrink-0 text-muted-foreground"
                                        />
                                        <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{file.path}</span>
                                        <span
                                            className="shrink-0 rounded-full px-1.5 text-[10px] font-medium"
                                            style={{ color: 'var(--muted-foreground)', backgroundColor: 'color-mix(in srgb, var(--muted-foreground) 12%, transparent)' }}
                                        >
                                            {t(`chat.workStatus.teamBoard.pullView.change.${file.changeType}`)}
                                        </span>
                                    </button>
                                    {expanded.has(file.path) ? (
                                        <PullDiffText view={view} file={file} />
                                    ) : null}
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            ) : null}
        </div>
    );
};

/**
 * The row colors a unified patch asks for: each line by its own kind, with
 * the translucent band behind it that DC-style diff views draw — the text
 * keeps its color token, the band keeps the row readable either way.
 */
const rowColorOf = (kind: DiffRow['kind']): string | null => {
    if (kind === 'added') return 'var(--status-success)';
    if (kind === 'removed') return 'var(--status-error)';
    if (kind === 'meta') return 'var(--muted-foreground)';
    return null;
};

/**
 * A unified patch, read-only and line-addressable: numbered rows in a
 * gutter, added and removed rows banded in their status colors, and any
 * line openable for a question — click a row to hold it, then the question
 * mark pins that line and its hunk window to the next message, where the
 * user writes the actual question. Hunk headers and the file header stay
 * pretty-printed meta: nothing stable to ask about there.
 */
const PullDiffText: React.FC<{
    view: BitbucketPullView;
    file: BitbucketPullView['files'][number];
}> = ({ view, file }) => {
    const { t } = useI18n();
    const rows = React.useMemo(() => parseDiffRows(file.diffText), [file.diffText]);
    const [selected, setSelected] = React.useState<number | null>(null);

    const askAboutLine = (index: number) => {
        const result = attachLineAsk(view, file, rows, index);
        if (!result.ok) {
            if (result.reason === 'no-session') toast.error(t('chat.workStatus.teamBoard.pullView.askNoSession'));
            else toast.error(t('chat.workStatus.teamBoard.pullView.askFailed'));
            return;
        }
        toast.message(t('chat.workStatus.teamBoard.pullView.askAttached'));
    };

    return (
        <div className="overflow-x-auto border-t border-border">
            {rows.map((row, index) => {
                const color = rowColorOf(row.kind);
                const selectable = row.oldLine !== null || row.newLine !== null;
                const isSelected = selected === index;
                return (
                    <div
                        key={index}
                        className={`group flex items-start gap-1.5 px-1 font-mono text-[11px] leading-4 ${selectable ? 'cursor-pointer' : ''}`}
                        style={{
                            backgroundColor: isSelected
                                ? 'color-mix(in srgb, var(--interactive.selection) 20%, transparent)'
                                : color
                                    ? `color-mix(in srgb, ${color} 8%, transparent)`
                                    : undefined,
                            color: color ?? undefined,
                        }}
                        onClick={selectable ? () => setSelected(isSelected ? null : index) : undefined}
                    >
                        <span className="w-7 shrink-0 select-none text-right text-[9px] text-muted-foreground/60">
                            {row.oldLine ?? row.newLine ?? ''}
                        </span>
                        <span className={`whitespace-pre ${selectable ? 'group-hover:opacity-80' : ''}`}>
                            {row.text || ' '}
                        </span>
                        {selectable ? (
                            <button
                                type="button"
                                aria-label={t('chat.workStatus.teamBoard.pullView.lineAskAria', {
                                    line: row.newLine ?? row.oldLine ?? 0,
                                    file: file.path,
                                })}
                                title={t('chat.workStatus.teamBoard.pullView.askAboutLine')}
                                className={`ml-auto inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-opacity hover:text-foreground ${
                                    isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'
                                }`}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    setSelected(index);
                                    askAboutLine(index);
                                }}
                            >
                                <Icon name="question" className="size-3.5" />
                            </button>
                        ) : null}
                    </div>
                );
            })}
        </div>
    );
};
