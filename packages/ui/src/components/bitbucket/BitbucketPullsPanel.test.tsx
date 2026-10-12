import React from 'react';
import { describe, expect, mock, test } from 'bun:test';
import { plugin } from 'bun';
import { pathToFileURL } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';

// Bun does not implement Vite's worker asset-query imports, and the diff
// rows now reach the syntax-coloring worker through the ask-reacting
// components' import chain.
plugin({
  name: 'pulls-shiki-worker-url',
  setup(build) {
    build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, ({ path }) => ({
      contents: `export default ${JSON.stringify(pathToFileURL(path.split('?')[0]).href)};`,
      loader: 'js',
    }));
  },
});

// The static markup reads a zustand store through its server snapshot — the
// state of creation time, blind to setState — so the panel's memory is a
// plain object the tests own, behind the store's own call shape.
type PullsMemory = {
  recents: Array<{ url: string; number: number; title: string; state: 'open' | 'merged' | 'closed'; at: number }>;
  noteRead: () => void;
  forget: () => void;
};

const memory: PullsMemory = {
  recents: [],
  noteRead: () => undefined,
  forget: () => undefined,
};

mock.module('@/stores/useBitbucketPullsStore', () => ({
  useBitbucketPullsStore: (selector: (state: PullsMemory) => PullsMemory[keyof PullsMemory]) => selector(memory),
}));

mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: {
    getState: () => ({ currentSessionId: 'session_1', getDirectoryForSession: (id: string) => `/work/${id}` }),
  },
}));

// The landing list is a read, not render state: the static markup only ever
// sees the pre-read moment, so the seam answers what a resolved read would.
mock.module('@/lib/bitbucket/pull-list-api', () => ({
  fetchBitbucketOpenPulls: async () => ({ ok: true, pulls: [], truncated: false }),
}));

const { BitbucketPullsPanel } = await import('./BitbucketPullsPanel');

const markupFor = (): string => renderToStaticMarkup(
  <I18nProvider>
    <BitbucketPullsPanel />
  </I18nProvider>,
);

describe('BitbucketPullsPanel', () => {
  test('the landing state names the input and says the open pulls are on their way', () => {
    const markup = markupFor();
    // The label is the input's aria-name: a screen reader hears what the
    // field is for. The placeholder names all three intents — link, number,
    // title — so the input teaches the search, not just the paste.
    expect(markup).toContain('Bitbucket pull-request URL');
    expect(markup).toContain('Link, pull number or title');
    // The open list's read has started; the landing state says so instead
    // of guessing at rows that have not arrived.
    expect(markup).toContain('Reading your open pull requests…');
  });

  test('a remembered read draws its row with the pull it names', () => {
    memory.recents = [
      { url: 'https://bitbucket.example/projects/AUTO/repos/ai-reviewer/pull-requests/110', number: 110, title: 'DEMO-7004 map the modules', state: 'merged', at: 1760000000000 },
    ];
    const markup = markupFor();
    expect(markup).toContain('#110');
    expect(markup).toContain('DEMO-7004 map the modules');
    // The state chip carries the merged words, so a glance answers whether
    // the pull still needs reading.
    expect(markup).toContain('merged');

    memory.recents = [];
  });

  test('an empty memory keeps the surface to the input and the pending list', () => {
    memory.recents = [];
    const markup = markupFor();
    expect(markup).not.toContain('Recently read');
  });
});
