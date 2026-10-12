import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';
import { formatDateTimeForPreference } from '@/lib/timeFormat';
import type { ViewErrorKind } from '@/lib/bitbucket/pull-view-api';
import { type BitbucketOpenPull, fetchBitbucketOpenPulls } from '@/lib/bitbucket/pull-list-api';
import { looksLikeUrl, matchesPullQuery, pullNumberOf } from '@/lib/bitbucket/pullSearch';
import { useUIStore } from '@/stores/useUIStore';
import { useBitbucketPullsStore } from '@/stores/useBitbucketPullsStore';
import { usePullView } from './usePullView';
import { BitbucketPullBody } from './BitbucketPullBody';
import { BitbucketAvatar } from './BitbucketAvatar';

/**
 * The dedicated Bitbucket pull surface — the context panel's tab for reading
 * any pull request of the configured Data Center instance, with or without a
 * team board. The landing state is the token's own open pulls, preloaded,
 * beside the recently read ones; the input reads a pasted link, jumps to a
 * number those lists know, or filters them in place. A read pull renders the
 * shared body, whose "Ask about this pull request" pins the material to the
 * session's next message. Read-only by construction: everything here
 * consumes the two GETs the server already owns.
 */
export const BitbucketPullsPanel: React.FC = () => {
    const { t } = useI18n();
    const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
    const recents = useBitbucketPullsStore((state) => state.recents);
    const noteRead = useBitbucketPullsStore((state) => state.noteRead);
    const forget = useBitbucketPullsStore((state) => state.forget);

    const [address, setAddress] = React.useState('');
    const [selected, setSelected] = React.useState<string | null>(null);
    const [readToken, setReadToken] = React.useState(0);
    const [listsOpen, setListsOpen] = React.useState(true);
    const [openPullsState, setOpenPullsState] = React.useState<
        { state: 'loading' } | { state: 'error'; kind: ViewErrorKind } | { state: 'ready'; pulls: BitbucketOpenPull[] }
    >({ state: 'loading' });
    const [listToken, setListToken] = React.useState(0);

    const view = usePullView(selected, readToken);

    // The open list is a read, not a cache: it happens when the surface
    // opens, again on retry, and a superseded answer never lands.
    React.useEffect(() => {
        let cancelled = false;
        setOpenPullsState({ state: 'loading' });
        void fetchBitbucketOpenPulls().then((result) => {
            if (cancelled) return;
            setOpenPullsState(result.ok ? { state: 'ready', pulls: result.pulls } : { state: 'error', kind: result.kind });
        });
        return () => {
            cancelled = true;
        };
    }, [listToken]);

    // Opening a pull folds both lists behind their headers instead of
    // hiding the memory: the read deserves the room, and the way back stays
    // one click, not an error state.
    React.useEffect(() => {
        if (selected !== null) setListsOpen(false);
    }, [selected]);

    // The recent read is noted once per fetched view, not per render: the
    // rowlist stays a memory of reads that actually happened.
    const noted = React.useRef<string | null>(null);
    React.useEffect(() => {
        if (view.state !== 'ready' || noted.current === view.view.pull.url) return;
        noted.current = view.view.pull.url;
        noteRead(view.view);
    }, [view, noteRead]);

    const openPull = (url: string) => {
        noted.current = null;
        setSelected(url);
        setReadToken((token) => token + 1);
    };

    // The input's three intents: a link reads on the server's word, a
    // number jumps to the pull the lists know, anything else has already
    // filtered the lists by the time it is submitted.
    const submit = () => {
        const trimmed = address.trim();
        if (!trimmed) return;
        if (looksLikeUrl(trimmed)) {
            openPull(trimmed);
            return;
        }
        const number = pullNumberOf(trimmed);
        if (number === null) return;
        const known = (openPullsState.state === 'ready'
            ? openPullsState.pulls.find((pull) => pull.number === number)
            : undefined) ?? recents.find((recent) => recent.number === number);
        if (known) openPull(known.url);
    };

    const errorWords = (kind: ViewErrorKind): string => t(`chat.workStatus.teamBoard.pullView.error.${kind}`);

    const formatStamp = (timestamp: number): string =>
        formatDateTimeForPreference(timestamp, timeFormatPreference, {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
        });

    const query = looksLikeUrl(address) ? '' : address;
    const visiblePulls = openPullsState.state === 'ready'
        ? openPullsState.pulls.filter((pull) => matchesPullQuery(pull, query))
        : [];
    const visibleRecents = recents.filter((recent) => matchesPullQuery(recent, query));
    const nothingMatches = openPullsState.state === 'ready' && query.trim() !== ''
        && visiblePulls.length === 0 && visibleRecents.length === 0;

    const hasPull = selected !== null && view.state !== 'idle';

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
                    placeholder={t('pullsPanel.searchPlaceholder')}
                    aria-label={t('pullsPanel.addressLabel')}
                />
                <Button type="submit" size="sm" disabled={address.trim() === ''}>
                    {t('pullsPanel.read')}
                </Button>
            </form>

            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-0.5">
                {openPullsState.state === 'loading' ? (
                    <p className="text-[13px] text-muted-foreground">{t('pullsPanel.listLoading')}</p>
                ) : null}

                {openPullsState.state === 'error' && openPullsState.kind !== 'unconfigured' ? (
                    <div className="flex items-center gap-2">
                        <p role="alert" className="text-[13px] text-muted-foreground">
                            {t('pullsPanel.listError')}
                        </p>
                        <Button type="button" variant="ghost" size="sm" onClick={() => setListToken((token) => token + 1)}>
                            {t('pullsPanel.listRetry')}
                        </Button>
                    </div>
                ) : null}

                {openPullsState.state === 'ready' ? (
                    <section className="space-y-1.5">
                        <button
                            type="button"
                            className="flex w-full items-center justify-between text-left"
                            onClick={() => setListsOpen((open) => !open)}
                        >
                            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                                {t('pullsPanel.openListTitle', { count: visiblePulls.length })}
                            </span>
                            <Icon
                                name={listsOpen ? 'arrow-down-s' : 'arrow-right-s'}
                                className="size-3.5 shrink-0 text-muted-foreground"
                            />
                        </button>
                        {listsOpen ? (
                            <div className="space-y-1">
                                {openPullsState.pulls.length === 0 && query.trim() === '' ? (
                                    <p className="text-[12px] text-muted-foreground">{t('pullsPanel.openListEmpty')}</p>
                                ) : null}
                                {visiblePulls.map((pull) => (
                                    <button
                                        key={pull.url}
                                        type="button"
                                        className="flex w-full items-start gap-2 rounded-lg border border-border px-2 py-1.5 text-left"
                                        onClick={() => openPull(pull.url)}
                                    >
                                        <BitbucketAvatar name={pull.author} slug={pull.authorSlug} className="mt-0.5" />
                                        <span className="min-w-0 flex-1">
                                            <span className="block truncate text-[12px]">{pull.title}</span>
                                            <span className="block truncate text-[11px] text-muted-foreground">
                                                #{pull.number} · {pull.repo.project}/{pull.repo.slug}
                                                {pull.author ? <> · {pull.author}</> : null}
                                            </span>
                                        </span>
                                        {pull.updatedAt ? (
                                            <span className="mt-0.5 shrink-0 text-[10px] text-muted-foreground">
                                                {formatStamp(pull.updatedAt)}
                                            </span>
                                        ) : null}
                                    </button>
                                ))}
                            </div>
                        ) : null}
                    </section>
                ) : null}

                {visibleRecents.length > 0 ? (
                    <section className="space-y-1.5">
                        <button
                            type="button"
                            className="flex w-full items-center justify-between text-left"
                            onClick={() => setListsOpen((open) => !open)}
                        >
                            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                                {t('pullsPanel.recentsTitle')}
                            </span>
                            <Icon
                                name={listsOpen ? 'arrow-down-s' : 'arrow-right-s'}
                                className="size-3.5 shrink-0 text-muted-foreground"
                            />
                        </button>
                        {listsOpen ? (
                            <div className="space-y-1">
                                {visibleRecents.map((entry) => (
                                    <div
                                        key={entry.url}
                                        className="flex items-center gap-1.5 rounded-lg border border-border px-2 py-1.5"
                                    >
                                        <button
                                            type="button"
                                            className="flex min-w-0 flex-1 items-center gap-2 text-left"
                                            onClick={() => openPull(entry.url)}
                                        >
                                            <span
                                                className="inline-flex shrink-0 items-center rounded-full px-1.5 text-[10px] font-medium leading-4"
                                                style={{
                                                    color: entry.state === 'merged'
                                                        ? 'var(--status-success)'
                                                        : entry.state === 'open'
                                                            ? 'var(--status-info)'
                                                            : 'var(--muted-foreground)',
                                                    backgroundColor: 'color-mix(in srgb, var(--muted-foreground) 12%, transparent)',
                                                }}
                                            >
                                                {t(`chat.workStatus.teamBoard.pull.${entry.state}`)}
                                            </span>
                                            <span className="min-w-0 flex-1 truncate text-[12px]">
                                                #{entry.number} · {entry.title}
                                            </span>
                                        </button>
                                        <button
                                            type="button"
                                            aria-label={t('pullsPanel.forget')}
                                            className="shrink-0 text-muted-foreground hover:text-foreground"
                                            onClick={() => forget(entry.url)}
                                        >
                                            <Icon name="close-circle" className="size-3.5" />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        ) : null}
                    </section>
                ) : null}

                {nothingMatches ? (
                    <p className="text-[13px] text-muted-foreground">{t('pullsPanel.noMatch')}</p>
                ) : null}

                {!hasPull && !nothingMatches && openPullsState.state !== 'loading' && visiblePulls.length === 0 ? (
                    <p className="text-[13px] text-muted-foreground">{t('pullsPanel.empty')}</p>
                ) : null}

                {view.state === 'loading' ? (
                    <p className="text-[13px] text-muted-foreground">
                        {t('chat.workStatus.teamBoard.pullView.loading')}
                    </p>
                ) : null}

                {view.state === 'error' ? (
                    <div className="space-y-2">
                        <p role="alert" className="text-[13px]" style={{ color: 'var(--status-error)' }}>
                            {errorWords(view.kind)}
                        </p>
                        <div className="flex items-center gap-2">
                            <Button type="button" size="sm" onClick={() => setReadToken((token) => token + 1)}>
                                {t('chat.workStatus.teamBoard.pullView.retry')}
                            </Button>
                            <Button type="button" variant="ghost" size="sm" onClick={() => setSelected(null)}>
                                {t('pullsPanel.back')}
                            </Button>
                        </div>
                    </div>
                ) : null}

                {view.state === 'ready' ? (
                    <BitbucketPullBody key={view.view.pull.url} view={view.view} />
                ) : null}
            </div>
        </div>
    );
};
