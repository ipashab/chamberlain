import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';
import type { PageErrorKind } from '@/lib/confluence/page-api';
import { fetchConfluenceSearch, type ConfluenceSearchRow } from '@/lib/confluence/page-api';

/**
 * The attached brief's picker: the small search that names a Confluence
 * page for an asking flow. One selection at a time — picking another page
 * replaces the first, because a reading carries one brief, not a shelf.
 * The search is the reader's own GET; nothing is fetched until the words
 * are asked on submit.
 */
export const ConfluencePagePicker: React.FC<{
    selection: { id: string; title: string } | null;
    onSelection: (page: { id: string; title: string } | null) => void;
}> = ({ selection, onSelection }) => {
    const { t } = useI18n();
    const [query, setQuery] = React.useState('');
    const [searchState, setSearchState] = React.useState<
        | { state: 'idle' }
        | { state: 'loading' }
        | { state: 'error'; kind: PageErrorKind }
        | { state: 'ready'; rows: ConfluenceSearchRow[] }
    >({ state: 'idle' });

    // A search is a read on submit: the token counter keeps a superseded
    // answer from landing — two rapid submits render the last one's rows.
    const searchToken = React.useRef(0);
    const runSearch = (words: string) => {
        searchToken.current += 1;
        const token = searchToken.current;
        setSearchState({ state: 'loading' });
        void fetchConfluenceSearch(words).then((result) => {
            if (token !== searchToken.current) return;
            setSearchState(result.ok ? { state: 'ready', rows: result.rows } : { state: 'error', kind: result.kind });
        });
    };

    // A fresh picker question starts a fresh answer: editing the words
    // retires the rows that answered a different question.
    React.useEffect(() => {
        setSearchState({ state: 'idle' });
    }, [query]);

    if (selection) {
        return (
            <div className="flex items-center gap-1.5 rounded-lg border border-border px-2 py-1.5">
                <Icon name="booklet" className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-[12px]" title={selection.title}>
                    {t('confluencePanel.pickerAttached', { title: selection.title })}
                </span>
                <button
                    type="button"
                    aria-label={t('confluencePanel.pickerRemove')}
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                    onClick={() => onSelection(null)}
                >
                    <Icon name="close-circle" className="size-3.5" />
                </button>
            </div>
        );
    }

    return (
        <div className="space-y-1.5">
            <div className="flex items-center gap-2">
                <Input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t('confluencePanel.pickerPlaceholder')}
                    aria-label={t('confluencePanel.pickerLabel')}
                />
                <Button type="button" size="sm" disabled={query.trim() === ''} onClick={() => runSearch(query.trim())}>
                    {t('confluencePanel.find')}
                </Button>
            </div>

            {searchState.state === 'loading' ? (
                <p className="text-[12px] text-muted-foreground">{t('confluencePanel.searchLoading')}</p>
            ) : null}

            {searchState.state === 'error' ? (
                <p role="alert" className="text-[12px]" style={{ color: 'var(--status-error)' }}>
                    {t(`confluencePanel.error.${searchState.kind}`)}
                </p>
            ) : null}

            {searchState.state === 'ready' ? (
                searchState.rows.length === 0 ? (
                    <p className="text-[12px] text-muted-foreground">{t('confluencePanel.searchEmpty')}</p>
                ) : (
                    <div className="space-y-1">
                        {searchState.rows.map((row) => (
                            <button
                                key={row.id}
                                type="button"
                                className="flex w-full items-start gap-2 rounded-lg border border-border px-2 py-1 text-left"
                                onClick={() => onSelection({ id: row.id, title: row.title })}
                            >
                                <span className="min-w-0 flex-1">
                                    <span className="block truncate text-[12px]">{row.title}</span>
                                    {row.space.name || row.space.key ? (
                                        <span className="block truncate text-[11px] text-muted-foreground">
                                            {row.space.name ?? row.space.key}
                                        </span>
                                    ) : null}
                                </span>
                            </button>
                        ))}
                    </div>
                )
            ) : null}
        </div>
    );
};
