import React from 'react';
import { toast } from 'sonner';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { getMarkdownSyntaxVars } from '@/components/chat/markdown/markdownSyntaxVars';
import { useWorkerHighlightedLines, type WorkerHighlightedLinesResult } from '@/components/code/useWorkerHighlightedLines';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useI18n } from '@/lib/i18n';
import { openExternalUrl } from '@/lib/url';
import { formatDateTimeForPreference } from '@/lib/timeFormat';
import { getLanguageFromExtension } from '@/lib/toolHelpers';
import { useUIStore } from '@/stores/useUIStore';
import type { BitbucketPullView } from '@/lib/bitbucket/pull-view-api';
import {
    attachCommentAsk,
    attachFileAsk,
    attachLinesAsk,
    attachPullAsk,
    type PullAskResult,
} from './pullAsk';
import { BitbucketAvatar } from './BitbucketAvatar';
import {
    anchorRowIndex,
    codeMapOf,
    parseDiffRows,
    type DiffRow,
} from '@/lib/bitbucket/pullDiff';
import type { AnalysisScope, CommentAnalysis } from './pullAnalysis';
import { clickedLine, draggedOverLine, emptySpan, type SpanState } from './pullSpan';
import { usePullAnalysis } from './usePullAnalysis';

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
    // The reading this pull asked for: its session, its answer, its verdicts.
    const reading = usePullAnalysis(view);
    const [analyzeOpen, setAnalyzeOpen] = React.useState(false);
    const [scope, setScope] = React.useState<AnalysisScope>({ comments: true, files: true });
    const [starting, setStarting] = React.useState(false);

    React.useEffect(() => {
        setTab('overview');
        setAnalyzeOpen(false);
    }, [view.pull.url]);

    // The reading starts in its own session; the panel only reports how the
    // starting went, in the two ways it can fail: nowhere to run, no model.
    const startAnalysis = async () => {
        setStarting(true);
        const result = await reading.start(scope);
        setStarting(false);
        if (!result.ok) {
            if (result.reason === 'no-model') toast.error(t('chat.workStatus.teamBoard.pullView.analyzeNoModel'));
            else toast.error(t('chat.workStatus.teamBoard.pullView.analyzeFailed'));
            return;
        }
        setAnalyzeOpen(false);
        toast.message(t('chat.workStatus.teamBoard.pullView.analyzeStarted'));
    };

    const verdictColor = (verdict: 'ok' | 'questions' | 'concerns'): string => {
        if (verdict === 'ok') return 'var(--status-success)';
        if (verdict === 'questions') return 'var(--status-warning)';
        return 'var(--status-error)';
    };

    const verdictLabel = (verdict: 'ok' | 'questions' | 'concerns'): string =>
        t(`chat.workStatus.teamBoard.pullView.verdict.${verdict}`);

    const ask = () => {
        reportAsk(attachPullAsk(view));
    };

    // One answer for every ask's failure, because the ways they fail never
    // differ: without a session there is nothing to pin to, and a refused
    // quote is a refused quote, whichever surface asked.
    const reportAsk = (result: PullAskResult): boolean => {
        if (!result.ok) {
            if (result.reason === 'no-session') toast.error(t('chat.workStatus.teamBoard.pullView.askNoSession'));
            else toast.error(t('chat.workStatus.teamBoard.pullView.askFailed'));
            return false;
        }
        toast.message(t('chat.workStatus.teamBoard.pullView.askAttached'));
        return true;
    };

    const askFile = (file: BitbucketPullView['files'][number]) => {
        reportAsk(attachFileAsk(view, file));
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
                    size="sm"
                    variant="ghost"
                    onClick={() => setAnalyzeOpen((open) => !open)}
                >
                    <Icon name="sparkling" className="size-3.5 shrink-0" />
                    {reading.entry
                        ? t('chat.workStatus.teamBoard.pullView.reanalyze')
                        : t('chat.workStatus.teamBoard.pullView.analyze')}
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

            {analyzeOpen ? (
                <div className="space-y-2 rounded-lg border border-border px-2.5 py-2">
                    <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                        {t('chat.workStatus.teamBoard.pullView.analyzeTitle')}
                    </div>
                    {(
                        [
                            ['comments', 'scopeComments'],
                            ['files', 'scopeFiles'],
                        ] as const
                    ).map(([field, labelKey]) => (
                        <label key={field} className="flex items-center gap-2 text-[12px]">
                            <input
                                type="checkbox"
                                checked={scope[field]}
                                onChange={(event) => setScope((previous) => ({ ...previous, [field]: event.target.checked }))}
                            />
                            {t(`chat.workStatus.teamBoard.pullView.${labelKey}`)}
                        </label>
                    ))}
                    <div className="flex items-center gap-2">
                        <Button type="button" size="sm" disabled={starting} onClick={() => void startAnalysis()}>
                            {t('chat.workStatus.teamBoard.pullView.analyzeStart')}
                        </Button>
                        <Button type="button" size="sm" variant="ghost" onClick={() => setAnalyzeOpen(false)}>
                            {t('chat.workStatus.teamBoard.pullView.analyzeCancel')}
                        </Button>
                    </div>
                </div>
            ) : null}

            {reading.entry && reading.analyzing ? (
                <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
                    <Icon name="sparkling" className="size-3.5 shrink-0 animate-pulse" />
                    <span className="min-w-0 flex-1">{t('chat.workStatus.teamBoard.pullView.analyzing')}</span>
                    <button
                        type="button"
                        className="shrink-0 text-[11px] underline decoration-dotted underline-offset-2 hover:text-foreground"
                        onClick={reading.openSession}
                    >
                        {t('chat.workStatus.teamBoard.pullView.openAnalysisSession')}
                    </button>
                </div>
            ) : null}

            {reading.entry && !reading.analyzing && !reading.analysis ? (
                <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
                    <span className="min-w-0 flex-1">{t('chat.workStatus.teamBoard.pullView.analysisUnreadable')}</span>
                    <button
                        type="button"
                        className="shrink-0 text-[11px] underline decoration-dotted underline-offset-2 hover:text-foreground"
                        onClick={reading.openSession}
                    >
                        {t('chat.workStatus.teamBoard.pullView.openAnalysisSession')}
                    </button>
                </div>
            ) : null}

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
                            borderColor: tab === entry.id ? 'var(--primary-base)' : 'transparent',
                            color: tab === entry.id ? 'var(--surface-foreground)' : 'var(--surface-muted-foreground)',
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

                    {reading.analysis?.overall ? (
                        <section className="space-y-1.5">
                            <div className="flex items-center gap-2">
                                <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                                    {t('chat.workStatus.teamBoard.pullView.correspondence')}
                                </div>
                                <span
                                    className="inline-flex items-center rounded-full px-1.5 text-[10px] font-medium leading-4"
                                    style={{
                                        color: verdictColor(reading.analysis.overall.verdict),
                                        backgroundColor: `color-mix(in srgb, ${verdictColor(reading.analysis.overall.verdict)} 12%, transparent)`,
                                    }}
                                >
                                    {verdictLabel(reading.analysis.overall.verdict)}
                                </span>
                            </div>
                            <div className="rounded-lg border border-border bg-[var(--surface-muted)]/40 px-2.5 py-2">
                                <SimpleMarkdownRenderer content={reading.analysis.overall.notes} disableLinkSafety variant="tool" enableFileReferences={false} />
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
                (() => {
                    // The instance keeps two kinds of comments: notes on the
                    // pull itself and notes hung on a file's diff. The split
                    // the overview page draws is drawn here too — general
                    // comments first, then file groups keeping their arrival
                    // order — so a thread is read next to the file it talks
                    // about, and every note and reply opens for a question.
                    const generalComments = view.comments.filter((comment) => !comment.anchor);
                    const fileGroups: Array<{ path: string; comments: BitbucketPullView['comments'] }> = [];
                    for (const comment of view.comments) {
                        if (!comment.anchor) continue;
                        const group = fileGroups.find((entry) => entry.path === comment.anchor?.path);
                        if (group) group.comments.push(comment);
                        else fileGroups.push({ path: comment.anchor.path, comments: [comment] });
                    }
                    return (
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
                                <>
                                    {generalComments.length > 0 ? (
                                        <section className="space-y-2">
                                            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                                                {t('chat.workStatus.teamBoard.pullView.commentsGeneral')}
                                            </div>
                                            {generalComments.map((comment) => (
                                                <PullCommentCard
                                                    key={comment.id}
                                                    view={view}
                                                    comment={comment}
                                                    annotation={reading.analysis?.comments.get(comment.id)}
                                                    formatStamp={formatStamp}
                                                    reportAsk={reportAsk}
                                                />
                                            ))}
                                        </section>
                                    ) : null}
                                    {fileGroups.map((group) => {
                                        const file = view.files.find((entry) => entry.path === group.path);
                                        return (
                                            <section key={group.path} className="space-y-2">
                                                <div className="flex min-w-0 items-baseline gap-1.5">
                                                    <span className="truncate font-mono text-[11px] text-foreground">
                                                        {group.path}
                                                    </span>
                                                    <span className="shrink-0 text-[10px] text-muted-foreground">
                                                        {t('chat.workStatus.teamBoard.pullView.comments', { count: group.comments.length })}
                                                    </span>
                                                </div>
                                                {group.comments.map((comment) => (
                                                    <PullCommentCard
                                                        key={comment.id}
                                                        view={view}
                                                        comment={comment}
                                                        file={file}
                                                        annotation={reading.analysis?.comments.get(comment.id)}
                                                        formatStamp={formatStamp}
                                                        reportAsk={reportAsk}
                                                    />
                                                ))}
                                            </section>
                                        );
                                    })}
                                </>
                            )}
                        </div>
                    );
                })()
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
                            {view.files.map((file, index) => {
                                const fileAnalysis = reading.analysis?.files.get(file.path);
                                return (
                                    <div key={`${file.path}-${index}`} className="rounded-lg border border-border">
                                        <div className="flex items-center gap-1.5 px-2 py-1.5 text-[12px]">
                                            <button
                                                type="button"
                                                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                                                onClick={() => toggleFile(file.path)}
                                                aria-expanded={expanded.has(file.path)}
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
                                            {fileAnalysis ? (
                                                <span
                                                    className="shrink-0 rounded-full px-1.5 text-[10px] font-medium leading-4"
                                                    style={{
                                                        color: verdictColor(fileAnalysis.verdict),
                                                        backgroundColor: `color-mix(in srgb, ${verdictColor(fileAnalysis.verdict)} 12%, transparent)`,
                                                    }}
                                                    title={fileAnalysis.notes || undefined}
                                                >
                                                    {verdictLabel(fileAnalysis.verdict)}
                                                </span>
                                            ) : null}
                                            <button
                                                type="button"
                                                className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground"
                                                aria-label={t('chat.workStatus.teamBoard.pullView.fileAskAria', { file: file.path })}
                                                title={t('chat.workStatus.teamBoard.pullView.askAboutFile')}
                                                onClick={() => askFile(file)}
                                            >
                                                <Icon name="question" className="size-3.5" />
                                            </button>
                                        </div>
                                        {fileAnalysis?.notes && expanded.has(file.path) ? (
                                            <div className="px-2 pb-1.5 text-[11px] leading-4 text-muted-foreground">
                                                <SimpleMarkdownRenderer content={fileAnalysis.notes} disableLinkSafety variant="tool" enableFileReferences={false} />
                                            </div>
                                        ) : null}
                                        {expanded.has(file.path) ? (
                                            <PullDiffText view={view} file={file} reportAsk={reportAsk} />
                                        ) : null}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            ) : null}
        </div>
    );
};

/**
 * One comment thread the instance's activity holds: the author, the time,
 * the resolved state the thread carries, and — when the comment hangs on
 * a file's diff — the line chip at its corner and, as its own block, the
 * code window the line lives in, the way the instance's own "Line +N"
 * note reads in place. Every note and every reply opens for a question:
 * the ask pins that thread, and for an anchored thread the code window it
 * talks about, to the next message. When a reading has something to say
 * about this thread, its footnote sits at the card's foot: the gist in one
 * line, the improvement options one click deeper.
 */
const PullCommentCard: React.FC<{
    view: BitbucketPullView;
    comment: BitbucketPullView['comments'][number];
    file?: BitbucketPullView['files'][number];
    annotation?: CommentAnalysis;
    formatStamp: (timestamp: number) => string;
    reportAsk: (result: PullAskResult) => boolean;
}> = ({ view, comment, file, annotation, formatStamp, reportAsk }) => {
    const { t } = useI18n();
    const anchor = comment.anchor;
    const lineMarker = anchor?.lineType === 'ADDED' ? '+' : anchor?.lineType === 'REMOVED' ? '−' : '';

    const askButton = (label: string, aria: string, onClick: () => void) => (
        <button
            type="button"
            className="ml-auto inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
            aria-label={aria}
            title={label}
            onClick={onClick}
        >
            <Icon name="question" className="size-3.5" />
        </button>
    );

    return (
        <div className="rounded-lg border border-border px-2.5 py-2">
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                <BitbucketAvatar name={comment.author} slug={comment.authorSlug} />
                <span className="font-medium text-foreground">{comment.author ?? '—'}</span>
                {comment.createdAt ? <span>{formatStamp(comment.createdAt)}</span> : null}
                {comment.resolved ? (
                    <span className="rounded-full px-1.5 text-[10px] font-medium" style={{ color: 'var(--status-success)' }}>
                        {t('chat.workStatus.teamBoard.pullView.resolved')}
                    </span>
                ) : null}
                {anchor && anchor.line !== null ? (
                    <span
                        className="rounded-full px-1.5 text-[10px] font-medium"
                        style={{ color: 'var(--muted-foreground)', backgroundColor: 'color-mix(in srgb, var(--muted-foreground) 12%, transparent)' }}
                    >
                        {t('chat.workStatus.teamBoard.pullView.anchorLine', { line: anchor.line })} {lineMarker}
                    </span>
                ) : null}
                {askButton(
                    t('chat.workStatus.teamBoard.pullView.commentAsk'),
                    t('chat.workStatus.teamBoard.pullView.commentAskAria', { author: comment.author ?? '—' }),
                    () => reportAsk(attachCommentAsk(view, comment)),
                )}
            </div>
            {anchor && anchor.line !== null && file ? (
                <PullDiffExcerpt file={file} anchor={anchor} />
            ) : null}
            <SimpleMarkdownRenderer content={comment.text} disableLinkSafety variant="tool" enableFileReferences={false} />
            {comment.replies.map((reply, index) => (
                <div key={`${comment.id}-${index}`} className="ml-3 mt-1 border-l border-border pl-2">
                    <div className="flex flex-wrap items-center gap-2 text-[11px]">
                        <span className="font-medium text-foreground">{reply.author ?? '—'}</span>
                        <span className="text-muted-foreground">{reply.createdAt ? formatStamp(reply.createdAt) : ''}</span>
                        {askButton(
                            t('chat.workStatus.teamBoard.pullView.replyAsk'),
                            t('chat.workStatus.teamBoard.pullView.replyAskAria', { author: reply.author ?? '—' }),
                            () => reportAsk(attachCommentAsk(view, comment, reply)),
                        )}
                    </div>
                    <SimpleMarkdownRenderer content={reply.text} disableLinkSafety variant="tool" enableFileReferences={false} />
                </div>
            ))}
            {annotation ? <CommentAnnotation annotation={annotation} /> : null}
        </div>
    );
};

/**
 * The reading's footnote on one thread: what the note really asks for,
 * whether it is fair, and — when a fix is wanted — the options the
 * analysis suggests, kept behind a click so the thread stays readable.
 */
const CommentAnnotation: React.FC<{ annotation: CommentAnalysis }> = ({ annotation }) => {
    const { t } = useI18n();
    const [open, setOpen] = React.useState(false);
    return (
        <div
            className="mt-1.5 rounded-md px-2 py-1.5 text-[11px] leading-4"
            style={{ color: 'var(--muted-foreground)', backgroundColor: 'color-mix(in srgb, var(--primary-base) 8%, transparent)' }}
        >
            <div className="flex items-start gap-1.5">
                <Icon name="sparkling" className="mt-0.5 size-3 shrink-0" />
                <SimpleMarkdownRenderer
                    className="min-w-0 flex-1"
                    content={annotation.summary}
                    disableLinkSafety
                    variant="tool"
                    enableFileReferences={false}
                />
                {annotation.justified !== null ? (
                    <span
                        className="shrink-0 rounded-full px-1.5 text-[10px] font-medium leading-4"
                        style={{
                            color: annotation.justified ? 'var(--status-success)' : 'var(--status-error)',
                            backgroundColor: `color-mix(in srgb, ${annotation.justified ? 'var(--status-success)' : 'var(--status-error)'} 12%, transparent)`,
                        }}
                    >
                        {annotation.justified
                            ? t('chat.workStatus.teamBoard.pullView.commentJustified')
                            : t('chat.workStatus.teamBoard.pullView.commentUnjustified')}
                    </span>
                ) : null}
                {annotation.variants.length > 0 ? (
                    <button
                        type="button"
                        className="shrink-0 rounded-sm hover:text-foreground"
                        aria-label={t('chat.workStatus.teamBoard.pullView.variantsToggle')}
                        title={t('chat.workStatus.teamBoard.pullView.variantsToggle')}
                        aria-expanded={open}
                        onClick={() => setOpen((previous) => !previous)}
                    >
                        <Icon name={open ? 'arrow-down-s' : 'arrow-right-s'} className="size-3" />
                    </button>
                ) : null}
            </div>
            {open && annotation.variants.length > 0 ? (
                <ul className="mt-1 list-disc space-y-0.5 pl-4">
                    {annotation.variants.map((variant, index) => (
                        <li key={index}>{variant}</li>
                    ))}
                </ul>
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
 * One row's code, in whatever state the coloring worker is in: a ready
 * row takes its colored form, a pass still running holds the row's place
 * invisibly so the block does not flash plain first, and a pass that
 * failed leaves plain text. The row's width never changes while its
 * color arrives.
 */
const HighlightedCode: React.FC<{
    text: string;
    html: string | undefined;
    status: WorkerHighlightedLinesResult['status'];
}> = ({ text, html, status }) => {
    if (html !== undefined) {
        return <span className="whitespace-pre" dangerouslySetInnerHTML={{ __html: html }} />;
    }
    if (status === 'loading') {
        return <span aria-hidden className="invisible whitespace-pre">{text}</span>;
    }
    return <span className="whitespace-pre">{text}</span>;
};

/**
 * One file's diff, parsed and paired with the colors the worker gives
 * its code. The whole diff tokenizes once per file — one worker call,
 * cached, so every window the file's code shows up in shares the same
 * pass — and each row keeps its place in it: `htmlOf` answers a row with
 * its colored form when the pass has it, undefined while it is still
 * running. `syntaxVars` carries the `--md-syntax-*` variables the colored
 * spans read, and rides on whatever element wraps the rows.
 */
const useHighlightedDiffFile = (path: string, diffText: string) => {
    const { currentTheme } = useThemeSystem();
    const syntaxVars = React.useMemo(() => getMarkdownSyntaxVars(currentTheme), [currentTheme]);
    const rows = React.useMemo(() => parseDiffRows(diffText), [diffText]);
    const codeMap = React.useMemo(() => codeMapOf(rows), [rows]);
    const language = getLanguageFromExtension(path) || 'text';
    const highlighted = useWorkerHighlightedLines(codeMap.code, language);
    const htmlOf = React.useCallback(
        (rowIndex: number): string | undefined => {
            const codeLine = codeMap.lineOf[rowIndex];
            if (codeLine < 0) return undefined;
            return highlighted.status === 'loading' ? highlighted.carriedLines[codeLine] : highlighted.lines?.[codeLine];
        },
        [codeMap, highlighted],
    );
    return { rows, syntaxVars, highlighted, htmlOf };
};

/**
 * A unified patch, read-only and line-addressable the way the instance's
 * diff view is: asking is a click-and-click or a drag on the rows
 * themselves. The first click on a line starts a span — the line holds a
 * highlight and waits. The second click on any line ends the span there
 * — the same line makes a span of one — and only then a single question
 * mark appears at the head of the held range; clicking it pins the span,
 * with the hunk window the lines live in, to the next message. Pressing
 * a line and dragging across rows draws the same range live — the band
 * follows the mouse and the held range with its mark is what the release
 * leaves behind. A click on another line drops the held range and starts
 * a fresh span from there, Escape drops either state outright, and a
 * line's own mark (shown on hover) starts a span from that line. Rows
 * carry no text selection: the drag belongs to the range, and the code
 * itself carries the instance's own colors the file type asks for, by
 * the file's extension.
 */
const PullDiffText: React.FC<{
    view: BitbucketPullView;
    file: BitbucketPullView['files'][number];
    reportAsk: (result: PullAskResult) => boolean;
}> = ({ view, file, reportAsk }) => {
    const { t } = useI18n();
    const { rows, syntaxVars, highlighted, htmlOf } = useHighlightedDiffFile(file.path, file.diffText);
    // The span the reader is building: one move per gesture, both gestures
    // routed through the pure transitions in `pullSpan`.
    const [pointer, setPointer] = React.useState<SpanState>(emptySpan);
    const { picking, span } = pointer;
    // The line the mouse went down on while a drag is live; null is no
    // drag. The release needs no verdict: a press that never crossed a
    // row fires the plain click below and is that click's to answer.
    const dragStart = React.useRef<number | null>(null);

    // Any release ends a drag wherever it lands; the held span (if the
    // drag drew one) stays for its mark.
    React.useEffect(() => {
        const release = () => {
            dragStart.current = null;
        };
        window.addEventListener('mouseup', release);
        return () => window.removeEventListener('mouseup', release);
    }, []);

    // Escape drops a started span or a held range; the listener lives
    // only while one of them is up.
    React.useEffect(() => {
        if (picking === null && span === null) return;
        const drop = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setPointer(emptySpan);
        };
        window.addEventListener('keydown', drop);
        return () => window.removeEventListener('keydown', drop);
    }, [picking === null, span === null]);

    // One door for the row's body and its hover mark alike: wherever the
    // click lands, the pure transition decides the next state.
    const aimRow = (index: number) => {
        setPointer((previous) => clickedLine(previous, index));
    };

    // Crossing into another row while the mouse is down draws the range
    // live; the start row itself keeps the state untouched.
    const dragOverRow = (index: number) => {
        const start = dragStart.current;
        if (start === null) return;
        const next = draggedOverLine(start, index);
        if (next !== null) setPointer(next);
    };

    const askSpan = () => {
        if (span === null) return;
        setPointer(emptySpan);
        reportAsk(attachLinesAsk(view, file, rows, span[0], span[1]));
    };

    const spanFirstRow = span !== null ? rows[span[0]] : undefined;
    const spanLastRow = span !== null ? rows[span[1]] : undefined;
    const spanFrom = spanFirstRow?.newLine ?? spanFirstRow?.oldLine ?? 0;
    const spanTo = spanLastRow?.newLine ?? spanLastRow?.oldLine ?? 0;

    return (
        // SAFETY: these are the `--md-syntax-*` custom properties the colored
        // code spans read; React types only standard style keys.
        <div className="overflow-x-auto border-t border-border" style={syntaxVars as React.CSSProperties}>
            {rows.map((row, index) => {
                const color = rowColorOf(row.kind);
                const selectable = row.oldLine !== null || row.newLine !== null;
                const band = picking === index || (span !== null && index >= span[0] && index <= span[1]);
                // The one mark a held range answers with, at its head.
                const headMark = span !== null && index === span[0];
                const lineRef = row.newLine ?? row.oldLine ?? 0;
                return (
                    <div
                        key={index}
                        className={`group relative flex items-start gap-1.5 px-1 font-mono text-[11px] leading-4 ${selectable ? 'cursor-pointer select-none' : ''}`}
                        style={{
                            backgroundColor: band
                                ? 'color-mix(in srgb, var(--primary-base) 16%, transparent)'
                                : color
                                    ? `color-mix(in srgb, ${color} 8%, transparent)`
                                    : undefined,
                            color: row.kind === 'meta' ? color ?? undefined : undefined,
                        }}
                        onClick={selectable ? () => aimRow(index) : undefined}
                        onMouseDown={selectable ? (event) => {
                            if (event.button === 0) dragStart.current = index;
                        } : undefined}
                        onMouseEnter={selectable ? () => dragOverRow(index) : undefined}
                    >
                        {selectable ? (
                            <button
                                type="button"
                                aria-label={
                                    headMark
                                        ? t('chat.workStatus.teamBoard.pullView.linesAskAria', { from: spanFrom, to: spanTo, file: file.path })
                                        : picking !== null
                                            ? t('chat.workStatus.teamBoard.pullView.pickEndAria', { line: lineRef, file: file.path })
                                            : t('chat.workStatus.teamBoard.pullView.lineAskAria', { line: lineRef, file: file.path })
                                }
                                title={
                                    headMark
                                        ? t('chat.workStatus.teamBoard.pullView.askAboutLines', { from: spanFrom, to: spanTo })
                                        : picking !== null
                                            ? t('chat.workStatus.teamBoard.pullView.pickEnd')
                                            : t('chat.workStatus.teamBoard.pullView.askAboutLine')
                                }
                                className={`absolute left-0 top-0 z-10 inline-flex size-4 items-center justify-center rounded-sm text-muted-foreground transition-opacity hover:text-foreground focus:opacity-100 ${
                                    headMark ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                                }`}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    if (headMark) {
                                        askSpan();
                                    } else {
                                        aimRow(index);
                                    }
                                }}
                            >
                                <Icon name="question" className="size-3.5" />
                            </button>
                        ) : null}
                        <span className="w-7 shrink-0 select-none text-right text-[9px] text-muted-foreground/60">
                            {row.oldLine ?? row.newLine ?? ''}
                        </span>
                        {row.kind === 'meta' ? (
                            <span className="whitespace-pre">{row.text || ' '}</span>
                        ) : (
                            <span className={`flex-1 min-w-0 ${selectable ? 'group-hover:opacity-80' : ''}`}>
                                <span className="shrink-0 select-none" style={{ color: color ?? undefined }}>
                                    {row.text.slice(0, 1) || ' '}
                                </span>
                                <HighlightedCode
                                    text={row.text.length > 1 ? row.text.slice(1) : ' '}
                                    html={htmlOf(index)}
                                    status={highlighted.status}
                                />
                            </span>
                        )}
                    </div>
                );
            })}
        </div>
    );
};

/**
 * The code window an anchored comment hangs on, the way the instance's
 * own PR page lets a thread be read in place: the rows around the note's
 * line, the line itself held by the selection band, read-only. Colors
 * come from the same whole-file worker pass the Changes tab pays for, so
 * many notes on one file color once. An anchor the diff no longer
 * contains — the pull moved on since the note — shows no window; the
 * card's line chip still names where it used to be.
 */
const PullDiffExcerpt: React.FC<{
    file: BitbucketPullView['files'][number];
    anchor: NonNullable<BitbucketPullView['comments'][number]['anchor']>;
}> = ({ file, anchor }) => {
    const { t } = useI18n();
    const { rows, syntaxVars, highlighted, htmlOf } = useHighlightedDiffFile(file.path, file.diffText);
    const window = React.useMemo(() => {
        const index = anchorRowIndex(rows, anchor);
        if (index === -1) return null;
        const first = Math.max(0, index - 4);
        const last = Math.min(rows.length, index + 5);
        return {
            anchorAt: index - first,
            rows: rows.slice(first, last).map((row, offset) => [row, first + offset] as const),
        };
    }, [rows, anchor]);

    if (window === null) return null;

    return (
        // SAFETY: these are the `--md-syntax-*` custom properties the colored
        // code spans read; React types only standard style keys.
        <div
            className="mt-2 overflow-x-auto rounded-md border border-border"
            style={syntaxVars as React.CSSProperties}
            aria-label={t('chat.workStatus.teamBoard.pullView.excerptAria', { line: anchor.line ?? 0, file: file.path })}
        >
            {window.rows.map(([row, rowIndex], index) => {
                const color = rowColorOf(row.kind);
                const isAnchor = index === window.anchorAt;
                return (
                    <div
                        key={index}
                        className="flex items-start gap-1.5 px-1 font-mono text-[11px] leading-4"
                        style={{
                            backgroundColor: isAnchor
                                ? 'color-mix(in srgb, var(--primary-base) 16%, transparent)'
                                : color
                                    ? `color-mix(in srgb, ${color} 8%, transparent)`
                                    : undefined,
                            color: row.kind === 'meta' ? color ?? undefined : undefined,
                        }}
                    >
                        <span className="w-7 shrink-0 select-none text-right text-[9px] text-muted-foreground/60">
                            {row.oldLine ?? row.newLine ?? ''}
                        </span>
                        {row.kind === 'meta' ? (
                            <span className="whitespace-pre">{row.text || ' '}</span>
                        ) : (
                            <span className="flex-1 min-w-0">
                                <span className="shrink-0 select-none" style={{ color: color ?? undefined }}>
                                    {row.text.slice(0, 1) || ' '}
                                </span>
                                <HighlightedCode
                                    text={row.text.length > 1 ? row.text.slice(1) : ' '}
                                    html={htmlOf(rowIndex)}
                                    status={highlighted.status}
                                />
                            </span>
                        )}
                    </div>
                );
            })}
        </div>
    );
};
