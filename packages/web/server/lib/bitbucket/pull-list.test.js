import { describe, expect, it, vi } from 'vitest';

import { BitbucketError } from './client.js';
import { readOpenPulls } from './pull-list.js';

const entry = ({ id, title, open, updatedDate = 1000, state, project = 'OTHER', slug = 'playtest' }) => ({
  id,
  title,
  state: state ?? (open ? 'OPEN' : 'MERGED'),
  open,
  createdDate: updatedDate - 1000,
  updatedDate,
  author: { user: { displayName: 'Pavel Ivanov', name: 'pivanov', slug: 'pivanov' } },
  fromRef: { repository: { slug, project: { key: project } } },
});

const page = (values, isLastPage = true) => ({ start: 0, limit: 100, isLastPage, values });

const config = { origin: 'https://bitbucket.example.com', token: 'BBDC-live' };

const makeRequest = (pages) => {
  const remaining = [...pages];
  return vi.fn(async ({ path }) => {
    expect(path).toBe('/rest/api/1.0/dashboard/pull-requests');
    const next = remaining.shift();
    if (!next) throw new Error('no more pages');
    return next;
  });
};

describe('readOpenPulls', () => {
  it('keeps the open pulls of the dashboard, drops the rest', async () => {
    const request = makeRequest([
      page([
        entry({ id: 8689, title: 'Add tracing headers', open: true, updatedDate: 2000 }),
        entry({ id: 8500, title: 'Merged long ago', open: false, updatedDate: 3000 }),
        entry({ id: 8667, title: 'Automate experiments', open: true, updatedDate: 1000 }),
      ]),
    ]);
    const list = await readOpenPulls({ request, config });
    expect(list).toEqual({
      pulls: [
        {
          number: 8689,
          url: 'https://bitbucket.example.com/projects/OTHER/repos/playtest/pull-requests/8689',
          title: 'Add tracing headers',
          state: 'open',
          author: 'Pavel Ivanov',
          authorSlug: 'pivanov',
          repo: { project: 'OTHER', slug: 'playtest' },
          createdAt: 1000,
          updatedAt: 2000,
        },
        {
          number: 8667,
          url: 'https://bitbucket.example.com/projects/OTHER/repos/playtest/pull-requests/8667',
          title: 'Automate experiments',
          state: 'open',
          author: 'Pavel Ivanov',
          authorSlug: 'pivanov',
          repo: { project: 'OTHER', slug: 'playtest' },
          createdAt: 0,
          updatedAt: 1000,
        },
      ],
      truncated: false,
    });
  });

  it('never lands a closed pull in the list', async () => {
    const request = makeRequest([page([entry({ id: 1, title: 'Done', open: false, state: 'MERGED' })])]);
    const list = await readOpenPulls({ request, config, limit: 25 });
    expect(list.pulls).toHaveLength(0);
    expect(list.truncated).toBe(false);
  });

  it('drops the entries whose repo coordinates never arrived', async () => {
    const broken = {
      id: 9,
      title: 'No repo',
      open: true,
      author: { user: null },
      fromRef: null,
    };
    const faceless = entry({ id: 11, title: 'No author name', open: true, updatedDate: 2 });
    faceless.author = { user: null };
    const request = makeRequest([page([broken, faceless, entry({ id: 10, title: 'Fine', open: true, updatedDate: 1 })])]);
    const list = await readOpenPulls({ request, config });
    expect(list.pulls.map((pull) => pull.number)).toEqual([11, 10]);
    expect(list.pulls[0].author).toBeNull();
    expect(list.pulls[0].authorSlug).toBeNull();
    expect(list.pulls[1].author).toBe('Pavel Ivanov');
  });

  it('stops at the cap and says so when open pulls may exist beyond it', async () => {
    const request = makeRequest([
      page([
        entry({ id: 1, title: 'One', open: true, updatedDate: 1 }),
        entry({ id: 2, title: 'Two', open: true, updatedDate: 2 }),
        entry({ id: 3, title: 'Three', open: true, updatedDate: 3 }),
      ]),
      page([entry({ id: 4, title: 'Four', open: true, updatedDate: 4 })]),
    ]);
    const list = await readOpenPulls({ request, config, limit: 2 });
    expect(list.pulls.map((pull) => pull.number)).toEqual([1, 2]);
    expect(list.truncated).toBe(true);
  });

  it('walks until the last page and stops without a truncation claim', async () => {
    const request = makeRequest([
      page([entry({ id: 1, title: 'One', open: true, updatedDate: 1 })], false),
      page([entry({ id: 2, title: 'Two', open: false, updatedDate: 2 })]),
    ]);
    const list = await readOpenPulls({ request, config, limit: 10 });
    expect(list.pulls.map((pull) => pull.number)).toEqual([1]);
    expect(list.truncated).toBe(false);
  });

  it('refuses an unconfigured connection before any request', async () => {
    const request = vi.fn();
    await expect(readOpenPulls({ request, config: null })).rejects.toMatchObject({ kind: 'unconfigured' });
    expect(request).not.toHaveBeenCalled();
  });

  it('demands the shape it reads', async () => {
    const request = vi.fn(async () => ({ values: 'not-a-list' }));
    await expect(readOpenPulls({ request, config })).rejects.toMatchObject({ kind: 'server-error' });
  });

  it('propagates the client error kinds untouched', async () => {
    const request = vi.fn(async () => {
      throw new BitbucketError('unauthorized', 'the access token was rejected', 401);
    });
    await expect(readOpenPulls({ request, config })).rejects.toMatchObject({ kind: 'unauthorized' });
  });
});
