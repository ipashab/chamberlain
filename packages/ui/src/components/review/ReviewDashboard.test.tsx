import React from 'react';
import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';

// The board's two reads never answer inside a static markup: the pulls GET
// rides behind a promise the test never settles, so the landing state is
// deterministic — the titles, the hints and the field, no rows.
mock.module('@/lib/bitbucket/pull-list-api', () => ({
    fetchBitbucketDashboardPulls: () => new Promise(() => undefined),
}));

// The verdict watcher subscribes to a directory store the static markup has
// no provider for; the empty wanted set reads no verdicts, so the store's
// answer is a constant the test owns, behind the hook's own call shape.
const syncContext = await import('@/sync/sync-context');
mock.module('@/sync/sync-context', () => ({
    ...syncContext,
    useDirectorySync: () => ({}),
}));

// The effective directory feeds nothing the static markup shows — only the
// row clicks' navigation — so the test pins it to «nowhere», and the board
// renders without the chat column's selection context.
mock.module('@/hooks/useEffectiveDirectory', () => ({
    useEffectiveDirectory: () => undefined,
}));

const { ReviewDashboard } = await import('./ReviewDashboard');

const markupFor = (): string => renderToStaticMarkup(
    <I18nProvider>
        <ReviewDashboard />
    </I18nProvider>,
);

describe('ReviewDashboard', () => {
    test('the landing state teaches what the board orders by', () => {
        const markup = markupFor();
        expect(markup).toContain('Open pulls by last reading');
        expect(markup).toContain('The board sorts by what the last reading said');
        expect(markup).toContain('Reading the board…');
        // The issues half names its field honestly: the same prefixes the
        // issues surface reads.
        expect(markup).toContain('Issues');
        expect(markup).toContain('Words or prefixes (assignee:, status:, project:)');
    });
});
