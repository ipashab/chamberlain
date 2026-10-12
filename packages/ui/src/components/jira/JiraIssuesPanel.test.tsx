import React from 'react';
import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';

// The static markup reads a zustand store through its server snapshot — the
// state of creation time, blind to setState — so the panel's memory is a
// plain object the tests own, behind the store's own call shape.
type IssuesMemory = {
  recents: Array<{ ref: string; key: string; summary: string; at: number }>;
  noteRead: () => void;
  forget: () => void;
};

const memory: IssuesMemory = {
  recents: [],
  noteRead: () => undefined,
  forget: () => undefined,
};

mock.module('@/stores/useJiraIssuesStore', () => ({
  useJiraIssuesStore: (selector: (state: IssuesMemory) => IssuesMemory[keyof IssuesMemory]) => selector(memory),
}));

const { JiraIssuesPanel } = await import('./JiraIssuesPanel');

const markupFor = (): string => renderToStaticMarkup(
  <I18nProvider>
    <JiraIssuesPanel />
  </I18nProvider>,
);

describe('JiraIssuesPanel', () => {
  test('the landing state names the input and teaches its three intents', () => {
    const markup = markupFor();
    // The label is the input's aria-name: a screen reader hears what the
    // field is for. The placeholder names all three intents — link, key,
    // title — so the input teaches the search, not just the paste.
    expect(markup).toContain('Jira issue URL or key');
    expect(markup).toContain('Link, key or title');
    // The landing state answers the empty surface with the teaching words
    // rather than a bare field.
    expect(markup).toContain('Paste a Jira issue link or key, or pick one you viewed before.');
  });

  test('a remembered read draws its row with the issue it names', () => {
    memory.recents = [
      { ref: 'https://jira.example.com/browse/DEMO-3223', key: 'DEMO-3223', summary: 'Сборка падает на выгрузке артефактов', at: 1760000000000 },
    ];
    const markup = markupFor();
    expect(markup).toContain('Recently viewed');
    expect(markup).toContain('DEMO-3223');
    expect(markup).toContain('Сборка падает на выгрузке артефактов');

    memory.recents = [];
  });

  test('an empty memory stays the input and the teaching words', () => {
    memory.recents = [];
    const markup = markupFor();
    expect(markup).not.toContain('Recently viewed');
  });
});
