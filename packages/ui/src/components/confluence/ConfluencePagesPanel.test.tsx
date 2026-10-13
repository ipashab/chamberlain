import React from 'react';
import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';

// The static markup reads a zustand store through its server snapshot — the
// state of creation time, blind to setState — so the panel's memory is a
// plain object the tests own, behind the store's own call shape.
type PagesMemory = {
  recents: Array<{ id: string; title: string; spaceName: string | null; at: number }>;
  noteRead: () => void;
  forget: () => void;
};

const memory: PagesMemory = {
  recents: [],
  noteRead: () => undefined,
  forget: () => undefined,
};

mock.module('@/stores/useConfluencePagesStore', () => ({
  useConfluencePagesStore: (selector: (state: PagesMemory) => PagesMemory[keyof PagesMemory]) => selector(memory),
}));

const { ConfluencePagesPanel } = await import('./ConfluencePagesPanel');

const markupFor = (): string => renderToStaticMarkup(
  <I18nProvider>
    <ConfluencePagesPanel />
  </I18nProvider>,
);

describe('ConfluencePagesPanel', () => {
  test('the landing state names the input and teaches its two intents', () => {
    const markup = markupFor();
    // The label is the input's aria-name: a screen reader hears what the
    // field is for. The placeholder names both intents — address, id,
    // title words — so the input teaches the read, not just the paste.
    expect(markup).toContain('Confluence page URL or id');
    expect(markup).toContain('Link, page id or title');
    expect(markup).toContain('Words search the pages; a pasted link or page id opens the page itself.');
    // The landing state answers the empty surface with the teaching words
    // rather than a bare field.
    expect(markup).toContain('Paste a Confluence page link or id, or pick one you viewed before.');
  });

  test('a remembered read draws its row with the page it names', () => {
    memory.recents = [
      { id: '9001', title: 'Release checklist', spaceName: 'Demo space', at: 1760000000000 },
    ];
    const markup = markupFor();
    expect(markup).toContain('Recently viewed');
    expect(markup).toContain('#9001');
    expect(markup).toContain('Release checklist');
    expect(markup).toContain('Demo space');

    memory.recents = [];
  });

  test('an empty memory stays the input and the teaching words', () => {
    memory.recents = [];
    const markup = markupFor();
    expect(markup).not.toContain('Recently viewed');
  });
});
