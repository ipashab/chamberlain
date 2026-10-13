import React from 'react';

import { toast } from 'sonner';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';
import { formatDateTimeForPreference } from '@/lib/timeFormat';
import type { PageErrorKind } from '@/lib/confluence/page-api';
import { fetchConfluenceSearch, type ConfluenceSearchRow } from '@/lib/confluence/page-api';
import { useUIStore } from '@/stores/useUIStore';
import { useConfluencePagesStore } from '@/stores/useConfluencePagesStore';
import { attachConfluencePageAsk, sanitizeRenderedPage, type PageAskResult } from './pageAsk';
import { pageIdOf } from './pageRef';
import { useConfluencePageView } from './useConfluencePageView';
import type { ConfluencePageView } from '@/lib/confluence/page-api';

/**
 * One sanitized render, mounted once per html string: the sanitize work
 * happens in a memo, so a re-render costs nothing but the DOM it owes.
 */
const SanitizedHtml: React.FC<{ html: string; className: string }> = ({ html, className }) => {
    const safe = React.useMemo(() => sanitizeRenderedPage(html), [html]);
    if (safe === null) return null;
    return <div className={className} dangerouslySetInnerHTML={{ __html: safe }} />;
};

/**
 * The dedicated Confluence surface — the context panel's tab for reading
 * any page of the configured Data Center instance. The landing state is
 * the recently read beside the field; the input reads a pasted page
 * address, a bare page id, or searches the instance for the words. A
 * read page renders its rendered body with "Ask about this page" for
 * the next message. Read-only by construction: everything here consumes
 * the GETs the server already owns.
 */
export const ConfluencePagesPanel: React.FC = () => {
    const { t } = useI18n();
    const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
    const recents = useConfluencePagesStore((state) => state.recents);
    const noteRead = useConfluencePagesStore((state) => state.noteRead);
    const forget = useConfluencePagesStore((state) => state.forget);

    const [address, setAddress] = React.useState('');
    const [selected, setSelected] = React.useState<string | null>(null);
    const [readToken, setReadToken] = React.useState(0);
    const [searchState, setSearchState] = React.useState<
        | { state: 'idle' }
        | { state: 'loading' }
        | { state: 'error'; kind: PageErrorKind }
        | { state: 'ready'; rows: ConfluenceSearchRow[] }
    >({ state: 'idle' });

    const view = useConfluencePageView(selected, readToken);

    // A search is a read on submit: the token counter keeps a superseded
    // answer from landing — two rapid submits render the last one's rows.
    const searchToken = React.useRef(0);
    const runSearch = (query: string) => {
        searchToken.current += 1;
        const token = searchToken.current;
        setSearchState({ state: 'loading' });
        void fetchConfluenceSearch(query).then((result) => {
            if (token !== searchToken.current) return;
            setSearchState(result.ok ? { state: 'ready', rows: result.rows } : { state: 'error', kind: result.kind });
        });
    };

    // The input's two intents: an address (or a bare id) reads the page on
    // the server's word, anything else asks the instance to search.
    const openPage = (reference: string) => {
        noted.current = null;
        setSelected(reference);
        setReadToken((token) => token + 1);
    };

    const submit = () => {
        const trimmed = address.trim();
        if (!trimmed) return;
        const id = pageIdOf(trimmed);
        if (id !== null) {
            openPage(id);
            return;
        }
        runSearch(trimmed);
    };

    // The recent read is noted once per fetched view, not per render: the
    // rowlist stays a memory of reads that actually happened.
    const noted = React.useRef<string | null>(null);
    React.useEffect(() => {
        if (view.state !== 'ready' || noted.current === view.view.id) return;
        noted.current = view.view.id;
        noteRead(view.view);
    }, [view, noteRead]);

    // One answer for every ask's failure, because the ways they fail never
    // differ: without a session there is nothing to pin to, and a refused
    // quote is a refused quote, whichever surface asked.
    const reportAsk = (result: PageAskResult): boolean => {
        if (!result.ok) {
            if (result.reason === 'no-session') toast.error(t('confluencePanel.askNoSession'));
            else toast.error(t('confluencePanel.askFailed'));
            return false;
        }
        toast.message(t('confluencePanel.askAttached'));
        return true;
    };

    const ask = () => {
        if (view.state !== 'ready') return;
        reportAsk(attachConfluencePageAsk(view.view));
    };

    const errorWords = (kind: PageErrorKind): string => t(`confluencePanel.error.${kind}`);

    const formatStamp = (iso: string | null): string =>
        formatDateTimeForPreference(Date.parse(iso ?? ''), timeFormatPreference, {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
        });

    // The field's words filter the memory, not the search: a search is a
    // question asked on submit, the rows it answers stay its own answer.
    const filterQuery = pageIdOf(address) !== null ? '' : address;
    const needle = filterQuery.trim().toLowerCase();
    const visibleRecents = needle === ''
        ? recents
        : recents.filter(
            (recent) => recent.title.toLowerCase().includes(needle)
                || (recent.spaceName ?? '').toLowerCase().includes(needle)
                || recent.id === needle,
        );
    const nothingMatches = needle !== '' && visibleRecents.length === 0
        && searchState.state !== 'loading';

    const hasPage = selected !== null && view.state !== 'idle';

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
                    placeholder={t('confluencePanel.searchPlaceholder')}
                    aria-label={t('confluencePanel.addressLabel')}
                />
                <Button type="submit" size="sm" disabled={address.trim() === ''}>
                    {t('confluencePanel.find')}
                </Button>
            </form>

            <p className="text-[11px] leading-relaxed text-muted-foreground">
                {t('confluencePanel.searchHint')}
            </p>

            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pe-0.5">
                {searchState.state === 'loading' ? (
                    <p className="text-[13px] text-muted-foreground">{t('confluencePanel.searchLoading')}</p>
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
                                if (!trimmed || pageIdOf(trimmed) !== null) return;
                                runSearch(trimmed);
                            }}
                        >
                            {t('confluencePanel.searchRetry')}
                        </Button>
                    </div>
                ) : null}

                {searchState.state === 'ready' ? (
                    <section className="space-y-1.5">
                        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                            {t('confluencePanel.searchTitle', { count: searchState.rows.length })}
                        </span>
                        <div className="space-y-1">
                            {searchState.rows.length === 0 ? (
                                <p className="text-[12px] text-muted-foreground">{t('confluencePanel.searchEmpty')}</p>
                            ) : null}
                            {searchState.rows.map((row) => (
                                <button
                                    key={row.id}
                                    type="button"
                                    className="flex w-full items-start gap-2 rounded-lg border border-border px-2 py-1.5 text-start"
                                    onClick={() => openPage(row.id)}
                                >
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate text-[12px]">{row.title}</span>
                                        {row.space.name || row.space.key ? (
                                            <span className="block truncate text-[11px] text-muted-foreground">
                                                {row.space.name ?? row.space.key}
                                            </span>
                                        ) : null}
                                    </span>
                                    {row.lastUpdated ? (
                                        <span className="mt-0.5 shrink-0 text-[10px] text-muted-foreground">
                                            {formatStamp(row.lastUpdated)}
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
                            {t('confluencePanel.recentsTitle')}
                        </span>
                        <div className="space-y-1">
                            {visibleRecents.map((entry) => (
                                <div
                                    key={entry.id}
                                    className="flex items-center gap-1.5 rounded-lg border border-border px-2 py-1.5"
                                >
                                    <button
                                        type="button"
                                        className="flex min-w-0 flex-1 items-center gap-2 text-start"
                                        onClick={() => openPage(entry.id)}
                                    >
                                        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                                            #{entry.id}
                                        </span>
                                        <span className="min-w-0 flex-1 truncate text-[12px]">{entry.title}</span>
                                        {entry.spaceName ? (
                                            <span className="shrink-0 truncate text-[10px] text-muted-foreground">
                                                {entry.spaceName}
                                            </span>
                                        ) : null}
                                    </button>
                                    <button
                                        type="button"
                                        aria-label={t('confluencePanel.forget')}
                                        className="shrink-0 text-muted-foreground hover:text-foreground"
                                        onClick={() => forget(entry.id)}
                                    >
                                        <Icon name="close-circle" className="size-3.5" />
                                    </button>
                                </div>
                            ))}
                        </div>
                    </section>
                ) : null}

                {nothingMatches ? (
                    <p className="text-[13px] text-muted-foreground">{t('confluencePanel.noMatch')}</p>
                ) : null}

                {!hasPage && !nothingMatches && searchState.state === 'idle' && visibleRecents.length === 0 ? (
                    <p className="text-[13px] text-muted-foreground">{t('confluencePanel.empty')}</p>
                ) : null}

                {view.state === 'loading' ? (
                    <p className="text-[13px] text-muted-foreground">{t('confluencePanel.loading')}</p>
                ) : null}

                {view.state === 'error' ? (
                    <div className="space-y-2">
                        <p role="alert" className="text-[13px]" style={{ color: 'var(--status-error)' }}>
                            {errorWords(view.kind)}
                        </p>
                        <div className="flex items-center gap-2">
                            <Button type="button" size="sm" onClick={() => setReadToken((token) => token + 1)}>
                                {t('confluencePanel.retry')}
                            </Button>
                            <Button type="button" variant="ghost" size="sm" onClick={() => setSelected(null)}>
                                {t('confluencePanel.back')}
                            </Button>
                        </div>
                    </div>
                ) : null}

                {view.state === 'ready' ? (
                    <ConfluencePageBody key={view.view.url} view={view.view} onAsk={ask} formatStamp={formatStamp} />
                ) : null}
            </div>
        </div>
    );
};

/**
 * The read view of one page: a header — the title, the space, the
 * version, the authors' facts — then the rendered body over what the
 * server already read, with "Ask about this page" for the next message.
 * Read-only everywhere: it renders what the server fetched and writes
 * nothing anywhere.
 */
const ConfluencePageBody: React.FC<{
    view: ConfluencePageView;
    onAsk: () => void;
    formatStamp: (iso: string | null) => string;
}> = ({ view, onAsk, formatStamp }) => {
    const { t } = useI18n();

    return (
        <section className="space-y-3">
            <header className="space-y-2">
                <h3 className="min-w-0 break-words text-sm font-semibold leading-snug">{view.title}</h3>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                    <span className="truncate">{view.space.name ?? view.space.key}</span>
                    {view.version !== null ? <span>v{view.version}</span> : null}
                    {view.updatedAt ? <span>{formatStamp(view.updatedAt)}</span> : null}
                    {view.updatedBy ? <span className="truncate">{view.updatedBy}</span> : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <Button type="button" size="sm" onClick={onAsk}>
                        <Icon name="sparkling" className="size-3.5 shrink-0" />
                        {t('confluencePanel.ask')}
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => window.open(view.url, '_blank', 'noreferrer')}>
                        {t('confluencePanel.openExternally')}
                    </Button>
                </div>
            </header>

            {view.truncated ? (
                <p className="text-[11px] leading-relaxed text-muted-foreground">{t('confluencePanel.truncated')}</p>
            ) : null}

            <div className="confluence-page-body space-y-2 text-[13px] leading-relaxed [&_a]:break-words [&_a]:underline [&_blockquote]:border-s-2 [&_blockquote]:border-border [&_blockquote]:ps-2 [&_code]:rounded [&_code]:bg-[var(--surface-muted)] [&_code]:px-1 [&_h1]:mt-2 [&_h1]:text-sm [&_h1]:font-semibold [&_h2]:mt-2 [&_h2]:text-[13px] [&_h2]:font-semibold [&_h3]:mt-1.5 [&_h3]:font-semibold [&_li]:ms-4 [&_ol]:list-decimal [&_p]:break-words [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-[var(--surface-muted)] [&_pre]:p-2 [&_table]:w-full [&_td]:border [&_td]:border-border [&_td]:px-1.5 [&_td]:py-1 [&_th]:border [&_th]:border-border [&_th]:bg-[var(--surface-muted)] [&_th]:px-1.5 [&_th]:py-1 [&_ul]:list-disc">
                <SanitizedHtml html={view.html} className="min-w-0" />
            </div>
        </section>
    );
};
