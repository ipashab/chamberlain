// The pull surface's one input, three intents: a pasted link reads the
// pull on the server's word, a number opens the pull the loaded lists
// know, anything else filters the lists in place. The split lives here as
// pure functions so the semantics are testable without a mounted panel.

/**
 * The number a query names — `#4242` and `4242` both read as 4242 — or
 * null when the words are not a number at all.
 */
export const pullNumberOf = (query: string): number | null => {
    const trimmed = query.trim().replace(/^#/, '');
    if (!/^\d+$/.test(trimmed)) return null;
    const number = Number.parseInt(trimmed, 10);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
};

/**
 * A pasted address: anything that starts like a URL goes to the server,
 * whose parser is the only authority on what a pull link is — and whose
 * `bad-url` answer words the mistake better than any local guess.
 */
export const looksLikeUrl = (query: string): boolean => /^https?:\/\//i.test(query.trim());

/** The state chips the list offers: DC owns the words, "all" is the panel's. */
export type PullStateFilter = 'open' | 'merged' | 'closed' | 'all';
export const PULL_STATE_FILTERS: ReadonlyArray<PullStateFilter> = ['open', 'merged', 'closed', 'all'];

/** A row answers whether the state chip keeps it ("all" keeps everything). */
export const matchesPullState = (state: string, filter: PullStateFilter): boolean =>
    filter === 'all' || state === filter;

/** The words a filter matches against a row: one lowercase haystack. */
const haystackOf = (parts: Array<string | null | undefined>): string =>
    parts.filter((part): part is string => Boolean(part)).join(' ').toLowerCase();

/**
 * A list row answers whether the query finds it: the number, the title,
 * the repo coordinates, the author and the state all count; case never
 * does. An empty query finds every row — the unfiltered list is the
 * landing state.
 */
export const matchesPullQuery = (
    row: {
        number: number;
        title: string;
        state?: string | null;
        author?: string | null;
        repo?: { project: string; slug: string } | null;
    },
    query: string,
): boolean => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return true;
    const words = haystackOf([
        `#${row.number}`,
        String(row.number),
        row.title,
        row.state ?? null,
        row.author ?? null,
        row.repo ? `${row.repo.project}/${row.repo.slug}` : null,
    ]);
    return words.includes(trimmed);
};
