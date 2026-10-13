import { describe, expect, it, vi } from 'vitest';

import { readConfluencePage } from './page.js';
import { readConfluenceSearch } from './search.js';

const config = { origin: 'https://confluence.example.com', token: 'CONF-test', verifySsl: true };

const pageBody = (overrides = {}) => ({
  id: '9001',
  title: 'Release checklist',
  space: { key: 'DEMO', name: 'Demo space' },
  version: { number: 7, when: '2026-10-10T10:00:00.000+0300' },
  history: { lastUpdated: { by: { displayName: 'Robin Stone', username: 'r.stone' }, when: '2026-10-10T10:00:00.000+0300' } },
  body: { view: { value: '<h1>Ready to ship</h1>' } },
  _links: { webui: '/spaces/DEMO/pages/9001/Release+checklist' },
  ...overrides,
});

describe('readConfluencePage', () => {
  it('answers the reader\'s whole view from the instance\'s own words', async () => {
    const request = vi.fn(async () => pageBody());
    const view = await readConfluencePage({ request, config, pageId: '9001' });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      path: '/rest/api/content/9001',
    }));
    expect(view).toEqual({
      id: '9001',
      title: 'Release checklist',
      space: { key: 'DEMO', name: 'Demo space' },
      version: 7,
      updatedAt: '2026-10-10T10:00:00.000+0300',
      updatedBy: 'Robin Stone',
      url: 'https://confluence.example.com/spaces/DEMO/pages/9001/Release+checklist',
      html: '<h1>Ready to ship</h1>',
      truncated: false,
    });
  });

  it('cuts a giant body and says so', async () => {
    const huge = '<p>'.padEnd(201_000, 'x');
    const request = vi.fn(async () => pageBody({ body: { view: { value: huge } } }));
    const view = await readConfluencePage({ request, config, pageId: '9001' });
    expect(view.truncated).toBe(true);
    expect(view.html.length).toBe(200_000);
  });

  it('keeps answering when the instance is terse about links or space', async () => {
    const request = vi.fn(async () => pageBody({ _links: null, space: null }));
    const view = await readConfluencePage({ request, config, pageId: '9001' });
    expect(view.url).toBe('https://confluence.example.com/spaces//pages/9001');
    expect(view.space).toEqual({ key: null, name: null });
  });

  it('refuses an id that is not a page number, before any request', async () => {
    const request = vi.fn();
    await expect(readConfluencePage({ request, config, pageId: '../../etc' }))
      .rejects.toMatchObject({ kind: 'not-found' });
    await expect(readConfluencePage({ request, config, pageId: 'DEMO-1' }))
      .rejects.toMatchObject({ kind: 'not-found' });
    expect(request).not.toHaveBeenCalled();
  });

  it('demands the shape it reads', async () => {
    const request = vi.fn(async () => ({ nothing: true }));
    await expect(readConfluencePage({ request, config, pageId: '9001' }))
      .rejects.toMatchObject({ kind: 'server-error' });
  });
});

describe('readConfluenceSearch', () => {
  it('maps the instance\'s rows and keeps the words plain', async () => {
    const request = vi.fn(async () => ({
      results: [
        {
          id: '9001',
          title: 'Release checklist',
          space: { key: 'DEMO', name: 'Demo space' },
          lastUpdated: '2026-10-10T10:00:00.000+0300',
          _links: { webui: '/spaces/DEMO/pages/9001' },
        },
        { id: '', title: 'dropped' },
      ],
    }));
    const list = await readConfluenceSearch({ request, config, query: 'release checklist' });
    const { search } = request.mock.calls[0][0];
    expect(search).toContain(encodeURIComponent('type=page'));
    expect(list.results).toEqual([{
      id: '9001',
      title: 'Release checklist',
      space: { key: 'DEMO', name: 'Demo space' },
      lastUpdated: '2026-10-10T10:00:00.000+0300',
      url: 'https://confluence.example.com/spaces/DEMO/pages/9001',
    }]);
  });

  it('drops CQL metacharacters before the words reach the instance', async () => {
    const request = vi.fn(async () => ({ results: [] }));
    await readConfluenceSearch({ request, config, query: 're"lease ~ чек\\лист/' });
    const { search } = request.mock.calls[0][0];
    const cql = decodeURIComponent(search);
    // The quotes and wildcards left are the CQL frame's own; the words
    // inside them carry nothing the instance would parse as an operator.
    expect(cql).toContain('release');
    expect(cql).toContain('чеклист');
    expect(cql).not.toContain('re"lease');
    expect(cql).not.toContain('чек\\лист');
    expect(cql).not.toContain('\\');
  });

  it('answers an empty list without asking the instance when nothing is left', async () => {
    const request = vi.fn();
    expect(await readConfluenceSearch({ request, config, query: '" " ' })).toEqual({ results: [] });
    expect(request).not.toHaveBeenCalled();
  });
});
