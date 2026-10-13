import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';
import { formatDateTimeForPreference } from '@/lib/timeFormat';
import type { ViewErrorKind } from '@/lib/jira/issue-view-api';
import { fetchJiraIssueSearch, type JiraIssueHit } from '@/lib/jira/issue-search-api';
import { issueKeyOf, looksLikeUrl, matchesIssueQuery } from '@/lib/jira/issueRef';
import { useUIStore } from '@/stores/useUIStore';
import { useJiraIssuesStore } from '@/stores/useJiraIssuesStore';
import { useIssueView } from './useIssueView';
import { JiraIssueBody } from './JiraIssueBody';

/**
 * The dedicated Jira issue surface — the context panel's tab for reading
 * any issue of the configured Data Center instance. The landing state is
 * the recently viewed beside the field; the input reads a pasted link,
 * an issue key, or searches the instance for the words. A read issue
 * renders the shared body, whose "Ask about this issue" pins the
 * material to the session's next message. Read-only by construction:
 * everything here consumes the GETs the server already owns.
 */
export const JiraIssuesPanel: React.FC = () => {
    const { t } = useI18n();
    const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
    const recents = useJiraIssuesStore((state) => state.recents);
    const noteRead = useJiraIssuesStore((state) => state.noteRead);
    const forget = useJiraIssuesStore((state) => state.forget);

    const [address, setAddress] = React.useState('');
    const [selected, setSelected] = React.useState<string | null>(null);
    const [readToken, setReadToken] = React.useState(0);
    const [searchState, setSearchState] = React.useState<
        | { state: 'idle' }
        | { state: 'loading' }
        | { state: 'error'; kind: ViewErrorKind }
        | { state: 'ready'; issues: JiraIssueHit[] }
    >({ state: 'idle' });

    const view = useIssueView(selected, readToken);

    // A search is a read on submit: the token counter keeps a superseded
    // answer from landing — two rapid submits render the last one's rows.
    const searchToken = React.useRef(0);
    const runSearch = (query: string) => {
        searchToken.current += 1;
        const token = searchToken.current;
        setSearchState({ state: 'loading' });
        void fetchJiraIssueSearch(query).then((result) => {
            if (token !== searchToken.current) return;
            setSearchState(result.ok ? { state: 'ready', issues: result.issues } : { state: 'error', kind: result.kind });
        });
    };

    // The input's three intents, split the pure helpers own: a link reads
    // on the server's word, a key becomes the canonical spelling and
    // reads the same way, anything else asks the instance to search.
    const openIssue = (ref: string) => {
        noted.current = null;
        setSelected(ref);
        setReadToken((token) => token + 1);
    };

    // A handoff from the review board: open on the issue it named. The
    // pending field is consumed once — the board's click is a target, not
    // a memory, so the surface never replays it on a later mount.
    React.useEffect(() => {
        const pendingIssueRef = useUIStore.getState().consumePendingIssue();
        if (pendingIssueRef) openIssue(pendingIssueRef);
    }, []);

    const submit = () => {
        const trimmed = address.trim();
        if (!trimmed) return;
        if (looksLikeUrl(trimmed)) {
            openIssue(trimmed);
            return;
        }
        const key = issueKeyOf(trimmed);
        if (key !== null) {
            openIssue(key);
            return;
        }
        runSearch(trimmed);
    };

    // The recent read is noted once per fetched view, not per render: the
    // rowlist stays a memory of reads that actually happened.
    const noted = React.useRef<string | null>(null);
    React.useEffect(() => {
        if (view.state !== 'ready' || noted.current === view.view.issue.key) return;
        noted.current = view.view.issue.key;
        noteRead(view.view);
    }, [view, noteRead]);

    const errorWords = (kind: ViewErrorKind): string => t(`jiraView.error.${kind}`);

    const formatStamp = (iso: string): string =>
        formatDateTimeForPreference(Date.parse(iso), timeFormatPreference, {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
        });

    // The field's words filter the memory, not the search: a search is a
    // question asked on submit, the rows it answers stay its own answer.
    const filterQuery = looksLikeUrl(address) || issueKeyOf(address) !== null ? '' : address;
    const visibleRecents = recents.filter((recent) => matchesIssueQuery(recent, filterQuery));
    const nothingMatches = filterQuery.trim() !== '' && visibleRecents.length === 0
        && searchState.state !== 'loading';

    const hasIssue = selected !== null && view.state !== 'idle';

    return (
        <div className="flex h-full min-h-0 flex-col gap-3">
            <form
                className="flex items-center gap-2"
                onSubmit={(event) => {
                    event.preventDefault();
                    submit();
                }}
            >
                <Input
                    value={address}
                    onChange={(event) => setAddress(event.target.value)}
                    placeholder={t('jiraPanel.searchPlaceholder')}
                    aria-label={t('jiraPanel.addressLabel')}
                />
                <Button type="submit" size="sm" disabled={address.trim() === ''}>
                    {t('jiraPanel.read')}
                </Button>
            </form>

            <p className="text-[11px] leading-relaxed text-muted-foreground">
                {t('jiraPanel.searchHint')}
            </p>

            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pe-0.5">
                {searchState.state === 'loading' ? (
                    <p className="text-[13px] text-muted-foreground">{t('jiraPanel.searchLoading')}</p>
                ) : null}

                {searchState.state === 'error' ? (
                    <div className="flex items-center gap-2">
                        <p role="alert" className="text-[13px]" style={{ color: 'var(--status-error)' }}>
                            {errorWords(searchState.kind)}
                        </p>
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                                const trimmed = address.trim();
                                if (!trimmed || looksLikeUrl(trimmed) || issueKeyOf(trimmed) !== null) return;
                                runSearch(trimmed);
                            }}
                        >
                            {t('jiraPanel.searchRetry')}
                        </Button>
                    </div>
                ) : null}

                {searchState.state === 'ready' ? (
                    <section className="space-y-1.5">
                        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                            {t('jiraPanel.searchTitle', { count: searchState.issues.length })}
                        </span>
                        <div className="space-y-1">
                            {searchState.issues.length === 0 ? (
                                <p className="text-[12px] text-muted-foreground">{t('jiraPanel.searchEmpty')}</p>
                            ) : null}
                            {searchState.issues.map((hit) => (
                                <button
                                    key={hit.key}
                                    type="button"
                                    className="flex w-full items-start gap-2 rounded-lg border border-border px-2 py-1.5 text-start"
                                    onClick={() => openIssue(hit.url)}
                                >
                                    <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{hit.key}</span>
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate text-[12px]">{hit.summary}</span>
                                        {hit.statusName ? (
                                            <span className="block truncate text-[11px] text-muted-foreground">
                                                {hit.statusName}
                                            </span>
                                        ) : null}
                                    </span>
                                    {hit.updated ? (
                                        <span className="mt-0.5 shrink-0 text-[10px] text-muted-foreground">
                                            {formatStamp(hit.updated)}
                                        </span>
                                    ) : null}
                                </button>
                            ))}
                        </div>
                    </section>
                ) : null}

                {visibleRecents.length > 0 ? (
                    <section className="space-y-1.5">
                        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                            {t('jiraPanel.recentsTitle')}
                        </span>
                        <div className="space-y-1">
                            {visibleRecents.map((entry) => (
                                <div
                                    key={entry.ref}
                                    className="flex items-center gap-1.5 rounded-lg border border-border px-2 py-1.5"
                                >
                                    <button
                                        type="button"
                                        className="flex min-w-0 flex-1 items-center gap-2 text-start"
                                        onClick={() => openIssue(entry.ref)}
                                    >
                                        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                                            {entry.key}
                                        </span>
                                        <span className="min-w-0 flex-1 truncate text-[12px]">{entry.summary}</span>
                                    </button>
                                    <button
                                        type="button"
                                        aria-label={t('jiraPanel.forget')}
                                        className="shrink-0 text-muted-foreground hover:text-foreground"
                                        onClick={() => forget(entry.ref)}
                                    >
                                        <Icon name="close-circle" className="size-3.5" />
                                    </button>
                                </div>
                            ))}
                        </div>
                    </section>
                ) : null}

                {nothingMatches ? (
                    <p className="text-[13px] text-muted-foreground">{t('jiraPanel.noMatch')}</p>
                ) : null}

                {!hasIssue && !nothingMatches && searchState.state === 'idle' && visibleRecents.length === 0 ? (
                    <p className="text-[13px] text-muted-foreground">{t('jiraPanel.empty')}</p>
                ) : null}

                {view.state === 'loading' ? (
                    <p className="text-[13px] text-muted-foreground">{t('jiraView.loading')}</p>
                ) : null}

                {view.state === 'error' ? (
                    <div className="space-y-2">
                        <p role="alert" className="text-[13px]" style={{ color: 'var(--status-error)' }}>
                            {errorWords(view.kind)}
                        </p>
                        <div className="flex items-center gap-2">
                            <Button type="button" size="sm" onClick={() => setReadToken((token) => token + 1)}>
                                {t('jiraView.retry')}
                            </Button>
                            <Button type="button" variant="ghost" size="sm" onClick={() => setSelected(null)}>
                                {t('jiraPanel.back')}
                            </Button>
                        </div>
                    </div>
                ) : null}

                {view.state === 'ready' ? (
                    <JiraIssueBody key={view.view.issue.url} view={view.view} />
                ) : null}
            </div>
        </div>
    );
};
