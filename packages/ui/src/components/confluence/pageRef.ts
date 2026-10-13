// The page reader's pure share: what a pasted address names — a page id
// is a number, and two URL forms carry it after `/pages/` — and whether
// words are a search at all. Nothing here touches stores or the DOM, so
// the whole contract is testable as text in, reference out.

/**
 * The page id a Confluence address carries, or null when the words are
 * not an address. Both URL forms answer: today's
 * `/spaces/DEMO/pages/9001/Title` and the page action's
 * `?pageId=9001`.
 */
export const pageIdOf = (raw: string): string | null => {
    const trimmed = raw.trim();
    if (trimmed === '') return null;
    const pathMatch = /\/pages\/(\d+)/.exec(trimmed);
    if (pathMatch !== null) return pathMatch[1] ?? null;
    const queryMatch = /[?&]pageId=(\d+)/.exec(trimmed);
    if (queryMatch !== null) return queryMatch[1] ?? null;
    // A bare number in the field is the page id itself — the honest read
    // of the reference the way the Jira field reads a bare key.
    if (/^\d+$/.test(trimmed)) return trimmed;
    return null;
};
