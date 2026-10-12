import { describe, expect, it, vi } from 'vitest';

import { createBitbucketRequest, BitbucketError } from './client.js';
import { fetchBitbucketPullSummaries, readBitbucketPullSummary } from './pull-summary.js';

const config = { origin: 'https://bb.example.com', context: '', token: 't', verifySsl: true };
const ref = { origin: 'https://bb.example.com', context: '', project: 'OC', slug: 'core', number: 42, url: 'https://bb.example.com/projects/OC/repos/core/pull-requests/42' };

const pullBody = (over = {}) => JSON.stringify({
  title: 'Refactor the queue',
  state: 'OPEN',
  fromRef: { latestCommit: 'abc123' },
  ...over,
});

const openPullRequest = createBitbucketRequest({
  fetchImpl: async ({ url }) => {
    if (url.endsWith('/rest/api/1.0/projects/OC/repos/core/pull-requests/42')) {
      return { status: 200, body: pullBody() };
    }
    if (url.includes('/rest/build-status/1.0/commits/')) {
      return {
        status: 200,
        body: JSON.stringify({ values: [{ state: 'SUCCESSFUL' }, { state: 'SUCCESSFUL' }] }),
      };
    }
    return { status: 404, body: '' };
  },
});

describe('readBitbucketPullSummary', () => {
  it('maps the pull and its build statuses into the board contract', async () => {
    const summary = await readBitbucketPullSummary({ request: openPullRequest, config, ref });
    expect(summary).toEqual({
      owner: 'OC',
      repo: 'core',
      number: 42,
      state: 'open',
      draft: false,
      title: 'Refactor the queue',
      mergeable: null,
      mergeableState: null,
      checks: { state: 'success', total: 2 },
    });
  });

  it('maps MERGED and DECLINED pulls without guessing a draft', async () => {
    const merged = createBitbucketRequest({ fetchImpl: async () => ({ status: 200, body: pullBody({ state: 'MERGED' }) }) });
    expect((await readBitbucketPullSummary({ request: merged, config, ref })).state).toBe('merged');
    const declined = createBitbucketRequest({ fetchImpl: async () => ({ status: 200, body: pullBody({ state: 'DECLINED' }) }) });
    expect((await readBitbucketPullSummary({ request: declined, config, ref })).state).toBe('closed');
  });

  it('rolls a failed build over the whole otherwise-green pull', async () => {
    const failing = createBitbucketRequest({
      fetchImpl: async ({ url }) => {
        if (url.includes('/build-status/')) {
          return { status: 200, body: JSON.stringify({ values: [{ state: 'SUCCESSFUL' }, { state: 'FAILED' }] }) };
        }
        return { status: 200, body: pullBody() };
      },
    });
    expect((await readBitbucketPullSummary({ request: failing, config, ref })).checks).toEqual({ state: 'failure', total: 2 });
  });

  it('answers unknown checks when the instance has no build statuses', async () => {
    const noBuilds = createBitbucketRequest({
      fetchImpl: async ({ url }) => (url.includes('/build-status/')
        ? { status: 404, body: '' }
        : { status: 200, body: pullBody() }),
    });
    expect((await readBitbucketPullSummary({ request: noBuilds, config, ref })).checks).toEqual({ state: 'unknown', total: 0 });
  });
});

describe('fetchBitbucketPullSummaries', () => {
  it('keeps one missing pull unknown and lets the rest live', async () => {
    const one = { ...ref, number: 42 };
    const two = { ...ref, number: 43 };
    const batch = createBitbucketRequest({
      fetchImpl: async ({ url }) => {
        if (url.endsWith('/pull-requests/43')) return { status: 404, body: '' };
        if (url.includes('/build-status/')) {
          // The missing pull never reaches its builds, so its commit is unknown.
          return { status: 200, body: JSON.stringify({ values: [] }) };
        }
        return { status: 200, body: pullBody() };
      },
    });
    const { summaries } = await fetchBitbucketPullSummaries({ request: batch, config, refs: [one, two] });
    expect(summaries).toHaveLength(2);
    expect(summaries.find((entry) => entry.key.includes('#42')).summary).toMatchObject({ state: 'open' });
    expect(summaries.find((entry) => entry.key.includes('#43')).summary).toBeNull();
  });

  it('answers no per-ref values at all when the token is rejected', async () => {
    const rejecting = createBitbucketRequest({ fetchImpl: async () => ({ status: 401, body: '' }) });
    await expect(fetchBitbucketPullSummaries({ request: rejecting, config, refs: [ref] }))
      .rejects.toBeInstanceOf(BitbucketError);
  });

  it('never carries another instance\'s coordinates to the configured one', async () => {
    const fetchImpl = vi.fn(async () => ({ status: 200, body: pullBody() }));
    const { summaries } = await fetchBitbucketPullSummaries({
      request: createBitbucketRequest({ fetchImpl }),
      config,
      refs: [
        { ...ref, origin: 'https://elsewhere.example.com' },
        { ...ref, context: '/dc' },
      ],
    });
    expect(summaries).toHaveLength(2);
    expect(summaries.every((entry) => entry.summary === null)).toBe(true);
    // The board's own instance read nothing on behalf of the strangers.
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
