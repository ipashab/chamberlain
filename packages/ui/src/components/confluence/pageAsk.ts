// The page reader's HTML share: the instance's rendered body narrowed to
// prose the way the Jira viewer narrows its HTML — the tags and
// attributes text carries, and nothing more. No images, no scripts, no
// classes: the instance is trusted, but the reader's walls do not move
// for anyone's markup.
//
// The material half pins the page to the session's next message: the
// text a person would paste — title, space, address, the words of the
// body — not the tags around them.

import DOMPurify, { type DOMPurify as DOMPurifyInstance } from 'dompurify';

import type { ConfluencePageView } from '@/lib/confluence/page-api';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';

/**
 * Confluence's rendered HTML narrowed to prose: the same allowlist the
 * Jira viewer holds, because it is the same kind of machine answering.
 */
const SANITIZE_CONFIG = {
    ALLOWED_TAGS: [
        'a', 'b', 'blockquote', 'br', 'code', 'div', 'em', 'h1', 'h2', 'h3', 'h4',
        'h5', 'h6', 'hr', 'i', 'li', 'ol', 'p', 'pre', 's', 'span', 'strong',
        'sub', 'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'u', 'ul',
    ],
    ALLOWED_ATTR: ['href'],
};

/**
 * The page reader's own purifier, a local instance so the chat's
 * sanitizer and its hooks stay untouched. Every link the reader keeps
 * opens in the user's browser, never inside the app; where no DOM can
 * sanitize at all the caller falls back to saying so, never mounts raw
 * markup.
 */
let purifier: DOMPurifyInstance | null = null;

const pagePurifier = (): DOMPurifyInstance | null => {
    if (purifier !== null) return purifier;
    if (!DOMPurify.isSupported) return null;
    const instance = DOMPurify(window);
    if (!instance.isSupported) return null;
    instance.addHook('afterSanitizeAttributes', (node) => {
        if (!(node instanceof HTMLAnchorElement)) return;
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noreferrer');
    });
    purifier = instance;
    return instance;
};

/**
 * The HTML the instance rendered, sanitized to that prose — or null when
 * no DOM can sanitize, where the caller shows its own words instead of
 * mounting what it could not check.
 */
export const sanitizeRenderedPage = (html: string): string | null => {
    const instance = pagePurifier();
    return instance === null ? null : instance.sanitize(html, SANITIZE_CONFIG);
};

export type PageAskResult =
    | { ok: true }
    | { ok: false; reason: 'no-session' | 'rejected' };

/**
 * The page's words, not its tags: the sanitized body read as text, with
 * a line per block element, so the pinned material reads like a page and
 * not like a wall of glued sentences. Where no DOM can read, the tags
 * stay and the words still ride along — a pin is a promise about
 * material, not about markup.
 */
const pageTextOf = (html: string): string => {
    const safe = sanitizeRenderedPage(html);
    const source = safe ?? html;
    try {
        const container = document.createElement('div');
        container.innerHTML = source;
        return container.textContent ?? '';
    } catch {
        return source.replace(/<[^>]+>/g, '');
    }
};

/**
 * The page as the ask's material: what a person pasting the page would
 * type — the header facts, then the words of the body. The cap the
 * server already applied is the cap the pin respects; the truncated
 * notice names itself, so the receiver knows the page kept going.
 */
export const buildPageViewMaterial = (view: ConfluencePageView): string => {
    const lines = [
        `Confluence page: ${view.title}`,
        `Space: ${view.space.name ?? view.space.key ?? 'unknown'}`,
        view.version !== null ? `Version: ${view.version}` : null,
        view.updatedAt ? `Updated: ${view.updatedAt}` : null,
        view.updatedBy ? `Updated by: ${view.updatedBy}` : null,
        `Address: ${view.url}`,
        view.truncated ? '(The page body was cut at what the reader could hold.)' : null,
        '',
        '---',
        '',
        pageTextOf(view.html),
    ];
    return lines.filter((line) => line !== null).join('\n');
};

/**
 * Pin one page to the next message of the current session as a labeled
 * quote — the same flow the Jira asks use, because the answer never
 * differs: the composer shows the chip, the user asks the question, the
 * material rides along. Nothing is sent from here — the pin is a promise
 * about the next message.
 */
export const attachConfluencePageAsk = (view: ConfluencePageView): PageAskResult => {
    const { currentSessionId, getDirectoryForSession } = useSessionUIStore.getState();
    const directory = currentSessionId ? getDirectoryForSession(currentSessionId) : null;
    if (!currentSessionId || !directory) {
        return { ok: false, reason: 'no-session' };
    }
    const label = `Confluence: ${view.title}`.slice(0, 80);
    const accepted = useInlineCommentDraftStore.getState().addDraft(
        { directory, sessionKey: currentSessionId },
        {
            source: 'file-quote',
            fileLabel: label,
            startLine: 0,
            endLine: 0,
            code: buildPageViewMaterial(view),
            language: 'markdown',
            text: '',
        },
    );
    return accepted === null ? { ok: false, reason: 'rejected' } : { ok: true };
};
