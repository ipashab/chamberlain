import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useI18n } from '@/lib/i18n';
import { formatDateTimeForPreference } from '@/lib/timeFormat';
import type { ViewErrorKind } from '@/lib/bitbucket/pull-view-api';
import type { ViewErrorKind as IssueViewErrorKind } from '@/lib/jira/issue-view-api';
import type { BitbucketDashboardPull } from '@/lib/bitbucket/pull-list-api';
import { fetchBitbucketDashboardPulls } from '@/lib/bitbucket/pull-list-api';
import { fetchJiraIssueSearch, type JiraIssueHit } from '@/lib/jira/issue-search-api';
import { recallPullAnalysis, type PullAnalysisEntry } from '@/components/bitbucket/pullAnalysisSession';
import { useUIStore } from '@/stores/useUIStore';
import { majorityDirectoryOf, reviewBoardRows, type ReviewRow } from './reviewBoard';
import { usePullVerdicts } from './usePullVerdicts';

/**
 * The review board — the context panel's tab that answers «what needs me
 * next» in one look. Open pulls sit at the top, each carrying its last
 * reading's verdict: concerns first, questions next, then approvals,
 * reads, and the unread tail; the Jira field beside them pulls the
 * sprint's issues with the same search the issues surface uses. A row's
 * click is a handoff: the pulls or issues surface opens on the row's own
 * target, through the pending field the surface consumes at its
 * opening. Read-only by construction: everything here reads the GETs
 * the other surfaces already own.
 */
export const ReviewDashboard: React.FC = () => {
    const { t } = useI18n();
    const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
    const effectiveDirectory = useEffectiveDirectory();

    // The pulls list is a read, not a cache: it happens when the board
    // opens, again on retry, and a superseded answer never lands.
    const [rawPulls, setRawPulls] = React.useState<BitbucketDashboardPull[] | null>(null);
    const [pullsError, setPullsError] = React.useState<ViewErrorKind | null>(null);
    const [refreshToken, setRefreshToken] = React.useState(0);

    React.useEffect(() => {
        let cancelled = false;
        setRawPulls(null);
        setPullsError(null);
        void fetchBitbucketDashboardPulls().then((result) => {
            if (cancelled) return;
            if (result.ok) setRawPulls(result.pulls);
            else setPullsError(result.kind);
        });
        return () => {
            cancelled = true;
        };
    }, [refreshToken]);

    // The memory is read once per list answer, not per render: the entries a
    // row needs are entries of pulls that exist, and only those.
    const entryByPullUrl = React.useMemo(() => {
        const next = new Map<string, PullAnalysisEntry | null>();
        if (rawPulls !== null) {
            for (const pull of rawPulls) {
                next.set(pull.url, recallPullAnalysis(pull.url));
            }
        }
        return next;
    }, [rawPulls]);

    const watched = React.useMemo(
        () => [...entryByPullUrl.values()].filter((entry): entry is PullAnalysisEntry => entry !== null),
        [entryByPullUrl],
    );
    const boardDirectory = React.useMemo(() => majorityDirectoryOf(watched), [watched]);
    const { verdictBySessionId, turningSessionIds } = usePullVerdicts(watched, boardDirectory);

    const rows = React.useMemo<ReviewRow[]>(() => reviewBoardRows(
        rawPulls ?? [],
        (url) => entryByPullUrl.get(url) ?? null,
        (entry) => verdictBySessionId[entry.sessionId] ?? null,
    ), [rawPulls, entryByPullUrl, verdictBySessionId]);

    const [issueQuery, setIssueQuery] = React.useState('');
    const [issuesState, setIssuesState] = React.useState<
        | { state: 'idle' }
        | { state: 'loading' }
        | { state: 'error'; kind: IssueViewErrorKind }
        | { state: 'ready'; issues: JiraIssueHit[] }
    >({ state: 'idle' });

    // One search per submit: the token counter keeps a superseded answer
    // from landing, so two rapid submits render the last one's rows.
    const issueToken = React.useRef(0);
    const runIssueSearch = (query: string) => {
        issueToken.current += 1;
        const token = issueToken.current;
        setIssuesState({ state: 'loading' });
        void fetchJiraIssueSearch(query).then((result) => {
            if (token !== issueToken.current) return;
            setIssuesState(result.ok ? { state: 'ready', issues: result.issues } : { state: 'error', kind: result.kind });
        });
    };

    // A row's click is a handoff: the target surface opens on the row's own
    // pull or issue, through the pending field the surface consumes at its
    // opening — the same deal the diff handoff uses.
    const navigateToPull = (url: string) => {
        const ui = useUIStore.getState();
        ui.setPendingPull(url);
        ui.openContextPanelTab(effectiveDirectory ?? '', { mode: 'pulls' });
    };
    const navigateToIssue = (ref: string) => {
        const ui = useUIStore.getState();
        ui.setPendingIssue(ref);
        ui.openContextPanelTab(effectiveDirectory ?? '', { mode: 'jira' });
    };

    const formatStamp = (timestamp: number | null | undefined): string =>
        formatDateTimeForPreference(timestamp ?? 0, timeFormatPreference, {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
        });

    // The chip colors speak the verdicts' own language: the same three
    // shades the pull body's chips read, and the muted plain rows wear.
    const bucketColor = (row: ReviewRow): string => {
        if (row.bucket === 'concerns') return 'var(--status-error)';
        if (row.bucket === 'questions') return 'var(--status-warning)';
        if (row.bucket === 'ok') return 'var(--status-success)';
        return 'var(--surface-muted)';
    };
    const bucketLabel = (row: ReviewRow): string => {
        if (row.entry !== null && turningSessionIds.has(row.entry.sessionId)) return t('reviewPanel.turning');
        if (row.bucket === 'concerns' || row.bucket === 'questions' || row.bucket === 'ok') {
            return t(`chat.workStatus.teamBoard.pullView.verdict.${row.bucket}`);
        }
        if (row.bucket === 'read') return t('reviewPanel.read');
        return t('reviewPanel.unread');
    };

    return (
        <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto pr-0.5">
            <section className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                        {t('reviewPanel.pullsTitle')}
                    </span>
                    {rawPulls !== null ? (
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => setRefreshToken((token) => token + 1)}
                        >
                            <Icon name="refresh" className="size-3.5 shrink-0" />
                            {t('reviewPanel.refresh')}
                        </Button>
                    ) : null}
                </div>

                {rawPulls === null && pullsError === null ? (
                    <p className="text-[13px] text-muted-foreground">{t('reviewPanel.loading')}</p>
                ) : null}

                {pullsError !== null ? (
                    <div className="flex items-center gap-2">
                        <p role="alert" className="text-[13px]" style={{ color: 'var(--status-error)' }}>
                            {t(`chat.workStatus.teamBoard.pullView.error.${pullsError}`)}
                        </p>
                        <Button type="button" variant="ghost" size="sm" onClick={() => setRefreshToken((token) => token + 1)}>
                            {t('reviewPanel.retry')}
                        </Button>
                    </div>
                ) : null}

                {rawPulls !== null ? (
                    rows.length === 0 ? (
                        <p className="text-[13px] text-muted-foreground">{t('reviewPanel.pullsEmpty')}</p>
                    ) : (
                        <div className="space-y-1">
                            {rows.map((row) => (
                                <button
                                    key={row.pull.url}
                                    type="button"
                                    className="flex w-full items-start gap-2 rounded-lg border border-border px-2 py-1.5 text-left"
                                    onClick={() => navigateToPull(row.pull.url)}
                                >
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate text-[12px]">
                                            #{row.pull.number} · {row.pull.title}
                                        </span>
                                        <span className="block truncate text-[11px] text-muted-foreground">
                                            {row.pull.repo.project}/{row.pull.repo.slug}
                                            {row.pull.author ? ` · ${row.pull.author}` : ''}
                                        </span>
                                    </span>
                                    <span className="flex shrink-0 flex-col items-end gap-1">
                                        <span
                                            className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                                            style={{
                                                color: bucketColor(row),
                                                backgroundColor: `color-mix(in srgb, ${bucketColor(row)} 12%, transparent)`,
                                            }}
                                        >
                                            {bucketLabel(row)}
                                        </span>
                                        {row.pull.updatedAt ? (
                                            <span className="text-[10px] text-muted-foreground">{formatStamp(row.pull.updatedAt)}</span>
                                        ) : null}
                                    </span>
                                </button>
                            ))}
                        </div>
                    )
                ) : null}

                <p className="text-[11px] leading-relaxed text-muted-foreground">{t('reviewPanel.pullsHint')}</p>
            </section>

            <section className="space-y-2">
                <span className="block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {t('reviewPanel.issuesTitle')}
                </span>
                <form
                    className="flex items-center gap-2"
                    onSubmit={(event) => {
                        event.preventDefault();
                        const trimmed = issueQuery.trim();
                        if (trimmed) runIssueSearch(trimmed);
                    }}
                >
                    <Input
                        value={issueQuery}
                        onChange={(event) => setIssueQuery(event.target.value)}
                        placeholder={t('reviewPanel.issuesPlaceholder')}
                        aria-label={t('reviewPanel.issuesTitle')}
                    />
                    <Button type="submit" size="sm" disabled={issueQuery.trim() === ''}>
                        {t('reviewPanel.find')}
                    </Button>
                </form>

                {issuesState.state === 'loading' ? (
                    <p className="text-[13px] text-muted-foreground">{t('reviewPanel.issuesLoading')}</p>
                ) : null}

                {issuesState.state === 'error' ? (
                    <div className="flex items-center gap-2">
                        <p role="alert" className="text-[13px]" style={{ color: 'var(--status-error)' }}>
                            {t(`jiraView.error.${issuesState.kind}`)}
                        </p>
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                                const trimmed = issueQuery.trim();
                                if (trimmed) runIssueSearch(trimmed);
                            }}
                        >
                            {t('reviewPanel.retry')}
                        </Button>
                    </div>
                ) : null}

                {issuesState.state === 'ready' ? (
                    issuesState.issues.length === 0 ? (
                        <p className="text-[13px] text-muted-foreground">{t('reviewPanel.issuesEmpty')}</p>
                    ) : (
                        <div className="space-y-1">
                            {issuesState.issues.map((hit) => (
                                <button
                                    key={hit.key}
                                    type="button"
                                    className="flex w-full items-start gap-2 rounded-lg border border-border px-2 py-1.5 text-left"
                                    onClick={() => navigateToIssue(hit.key)}
                                >
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate text-[12px]">
                                            {hit.key} · {hit.summary}
                                        </span>
                                        {hit.statusName ? (
                                            <span className="block truncate text-[11px] text-muted-foreground">
                                                {hit.statusName}
                                            </span>
                                        ) : null}
                                    </span>
                                    {hit.updated ? (
                                        <span className="shrink-0 text-[10px] text-muted-foreground">{hit.updated}</span>
                                    ) : null}
                                </button>
                            ))}
                        </div>
                    )
                ) : null}

                <p className="text-[11px] leading-relaxed text-muted-foreground">{t('reviewPanel.issuesHint')}</p>
            </section>
        </div>
    );
};
