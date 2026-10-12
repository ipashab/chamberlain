// The Jira surface's one input, three intents: a pasted link reads the
// issue on the server's word, an issue key opens the issue it names, and
// anything else searches the instance. The split lives here as pure
// functions so the semantics are testable without a mounted panel.

/**
 * A pasted address: anything that starts like a URL goes to the server,
 * whose parser is the only authority on what an issue link is — and whose
 * `bad-ref` answer words the mistake better than any local guess.
 */
export const looksLikeUrl = (query: string): boolean => /^https?:\/\//i.test(query.trim());

/** The key grammar, case-insensitive here so typing stays human-friendly. */
const ISSUE_KEY_INPUT_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,9}-\d{1,6}$/;

/**
 * The issue key a query names — `DEMO-3223` and `idp-3223` both read as
 * DEMO-3223 — or null when the words are not a key at all. Jira prints
 * keys in caps, so the spelling the server reads is the upper one.
 */
export const issueKeyOf = (query: string): string | null => {
    const trimmed = query.trim();
    if (!ISSUE_KEY_INPUT_PATTERN.test(trimmed)) return null;
    return trimmed.toUpperCase();
};

/** The words a filter matches against a row: one lowercase haystack. */
const haystackOf = (parts: Array<string | null | undefined>): string =>
    parts.filter((part): part is string => Boolean(part)).join(' ').toLowerCase();

/**
 * A list row answers whether the query finds it: the key, the summary and
 * the status all count; case never does. An empty query finds every row —
 * the unfiltered list is the landing state.
 */
export const matchesIssueQuery = (
    row: { key: string; summary: string; statusName?: string | null },
    query: string,
): boolean => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return true;
    const words = haystackOf([row.key, row.summary, row.statusName ?? null]);
    return words.includes(trimmed);
};

/**
 * The issue keys the composer's text mentions: standalone tokens in the
 * server's own spelling, first one first, no duplicates — surfaced so a
 * message about DEMO-3223 can carry the issue itself. A browse URL does
 * not count: links stay the panel's input, whose reader words its own
 * mistakes. The word must stand alone; a prefix or suffix gluing it to
 * letters or digits keeps it out, so ids inside larger words stay words.
 */
const MENTION_PATTERN = /(?:^|[\s([{"'`])[A-Z][A-Z0-9]{0,9}-\d{1,6}(?=$|[\s.,;:!?)"'`\]}])/g;

export const findJiraIssueMentions = (text: string): string[] => {
    const found: string[] = [];
    const seen = new Set<string>();
    for (const match of text.matchAll(MENTION_PATTERN)) {
        const token = match[0];
        // The boundary character can ride inside the match; the key is its
        // tail, which the pattern's anchors leave uppercase-keyed.
        const key = token.replace(/^[^\p{L}\p{N}]+/u, '');
        if (!seen.has(key)) {
            seen.add(key);
            found.push(key);
        }
    }
    return found;
};
