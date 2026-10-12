import { describe, expect, it, vi } from 'vitest';

import { BitbucketError } from './client.js';
import { readPullView } from './pull-view.js';

const PULL_URL = 'https://bitbucket.example.com/projects/AUTO/repos/ai-reviewer/pull-requests/110';

const META_BODY = {
  title: 'Remove the temporary exception',
  description: 'The feature flag has served its purpose.',
  state: 'MERGED',
  createdDate: 1789660000000,
  updatedDate: 1789669800000,
  author: { user: { displayName: 'Sv Gorbunov', name: 'sgorbunov', slug: 'sgorbunov' }, role: 'AUTHOR', approved: false, status: 'UNAPPROVED' },
  reviewers: [
    { approved: true, status: 'APPROVED', user: { displayName: 'Alex Coder', slug: 'acoder' } },
    { approved: false, status: 'UNAPPROVED', user: { displayName: null, name: null, slug: 'ci' } },
  ],
  fromRef: { id: 'refs/heads/fix', displayId: 'fix', latestCommit: 'abc123' },
  toRef: { id: 'refs/heads/master', displayId: 'master', latestCommit: 'def456' },
};

const DIFF_BODY = {
  truncated: false,
  diffs: [
    {
      truncated: false,
      source: { toString: 'src/services/bitbucket/files.py' },
      destination: { toString: 'src/services/bitbucket/files.py' },
      hunks: [
        {
          sourceLine: 4,
          sourceSpan: 2,
          destinationLine: 4,
          destinationSpan: 3,
          segments: [
            {
              type: 'CONTEXT',
              truncated: false,
              lines: [{ source: 4, destination: 4, line: 'import yaml', truncated: false }],
            },
            {
              type: 'REMOVED',
              truncated: false,
              lines: [{ source: 5, destination: null, line: 'LEGACY_EXCEPTION = True', truncated: false }],
            },
            {
              type: 'ADDED',
              truncated: false,
              lines: [{ source: null, destination: 5, line: 'LEGACY_EXCEPTION = False', truncated: false }],
            },
          ],
        },
      ],
    },
    {
      truncated: false,
      source: null,
      destination: { toString: 'src/new.py' },
      hunks: [],
    },
    {
      truncated: true,
      source: { toString: 'src/gone.py' },
      destination: null,
      hunks: [],
    },
  ],
};

const ACTIVITY_WITH_COMMENT = {
  id: 5652998,
  createdDate: 1789664696177,
  action: 'COMMENTED',
  comment: {
    id: 99001,
    text: '## Review run info',
    threadResolved: false,
    severity: null,
    createdDate: 1789664696177,
    author: { displayName: 'AIR', name: 'ci', slug: 'ci' },
    comments: [
      {
        id: 99002,
        text: 'Acknowledged.',
        threadResolved: null,
        severity: null,
        createdDate: 1789664999000,
        author: { displayName: 'Sv Gorbunov', slug: 'sgorbunov' },
        comments: [],
      },
    ],
  },
};

// A review comment hangs on a file and a line: DC sends the anchor on the
// activity, and the same anchor inside the comment.
const ACTIVITY_WITH_ANCHORED_COMMENT = {
  id: 5767341,
  createdDate: 1789750000000,
  action: 'COMMENTED',
  commentAnchor: {
    path: 'autotests/experiments/src/client.py',
    line: 15,
    lineType: 'ADDED',
    fileType: 'TO',
  },
  comment: {
    id: 99010,
    text: 'свагера не было?',
    threadResolved: false,
    severity: 'NORMAL',
    createdDate: 1789750000000,
    author: { displayName: 'Robin Stone', slug: 'r.stone' },
    anchor: {
      path: 'autotests/experiments/src/client.py',
      line: 15,
      lineType: 'ADDED',
    },
    comments: [],
  },
};

const ACTIVITY_NON_COMMENT = {
  id: 5653044,
  createdDate: 1789669800000,
  action: 'MERGED',
  commit: 'def456',
};

const COMMITS_BODY = {
  isLastPage: true,
  values: [
    {
      id: 'abc123def4567890abcdef',
      displayId: 'abc123d',
      author: { name: 'Sv Gorbunov' },
      authorTimestamp: 1789660000,
      message: 'Remove the temporary exception\n\nThe flag served its purpose.',
    },
    {
      id: '111222333444555',
      author: { name: 'Alex Coder' },
      authorTimestamp: 1789661200,
      message: 'Add the removal note',
    },
  ],
};

const makeRequest = ({ meta = META_BODY, diff = DIFF_BODY, builds, commits = COMMITS_BODY, pages = [{ isLastPage: true, values: [] }] } = {}) => {
  const call = vi.fn(async ({ path, search = '' }) => {
    if (path.endsWith('/diff')) return diff;
    if (path.startsWith('/rest/build-status/1.0/commits/')) {
      if (builds === undefined) throw new BitbucketError('not-found', 'no build statuses', 404);
      return builds;
    }
    if (path.endsWith('/commits')) return commits;
    if (path.endsWith('/activities')) {
      const page = pages.shift();
      return page;
    }
    return meta;
  });
  return call;
};

describe('readPullView', () => {
  const ref = {
    origin: 'https://bitbucket.example.com',
    context: '',
    project: 'AUTO',
    slug: 'ai-reviewer',
    number: 110,
  };
  const config = { origin: 'https://bitbucket.example.com', token: 'BBDC-x' };

  it('assembles the pull meta from the REST body', async () => {
    const request = makeRequest();
    const view = await readPullView({ request, config, ref });
    expect(view.pull).toEqual({
      number: 110,
      url: PULL_URL,
      title: 'Remove the temporary exception',
      description: 'The feature flag has served its purpose.',
      state: 'merged',
      author: 'Sv Gorbunov',
      authorSlug: 'sgorbunov',
      createdAt: 1789660000000,
      updatedAt: 1789669800000,
      fromBranch: 'fix',
      toBranch: 'master',
      reviewers: [
        { name: 'Alex Coder', slug: 'acoder', approved: true },
        // DisplayName and name missing: the slug is the last honest word.
        { name: 'ci', slug: 'ci', approved: false },
      ],
      // The commit is known, the build-status plugin is not installed:
      // unknown checks, honestly — never null, which is the no-commit word.
      checks: { state: 'unknown', total: 0 },
    });
  });

  it('reads a bare author too: an older DC answering the plain person', async () => {
    const bare = { ...META_BODY, author: { displayName: 'Sv Gorbunov' } };
    const view = await readPullView({ request: makeRequest({ meta: bare }), config, ref });
    expect(view.pull.author).toBe('Sv Gorbunov');
    // A bare person without a slug has no avatar to ask for: null, honestly.
    expect(view.pull.authorSlug).toBeNull();
  });

  it('rolls the build statuses into the checks, unknown when the plugin is absent', async () => {
    const view = await readPullView({
      request: makeRequest({ builds: { values: [{ state: 'FAILED' }, { state: 'SUCCESSFUL' }] } }),
      config,
      ref,
    });
    expect(view.pull.checks).toEqual({ state: 'failure', total: 2 });

    const withoutPlugin = await readPullView({ request: makeRequest(), config, ref });
    expect(withoutPlugin.pull.checks).toEqual({ state: 'unknown', total: 0 });
  });

  it('rebuilds each file as a unified patch, locally, with its change kind', async () => {
    const view = await readPullView({ request: makeRequest(), config, ref });
    expect(view.files).toHaveLength(3);
    const [modified, added, deleted] = view.files;
    expect(modified).toEqual({
      path: 'src/services/bitbucket/files.py',
      changeType: 'modify',
      truncated: false,
      diffText: [
        'diff --git a/src/services/bitbucket/files.py b/src/services/bitbucket/files.py',
        '--- a/src/services/bitbucket/files.py',
        '+++ b/src/services/bitbucket/files.py',
        '@@ -4,2 +4,3 @@',
        ' import yaml',
        '-LEGACY_EXCEPTION = True',
        '+LEGACY_EXCEPTION = False',
      ].join('\n'),
    });
    expect(added).toMatchObject({
      path: 'src/new.py',
      changeType: 'add',
      diffText: [
        'diff --git a/src/new.py b/src/new.py',
        '--- /dev/null',
        '+++ b/src/new.py',
      ].join('\n'),
    });
    expect(deleted).toMatchObject({ path: 'src/gone.py', changeType: 'delete', truncated: true });
    expect(view.truncated.diff).toBe(true);
  });

  it('lists the commits: summary only, short sha, seconds into milliseconds', async () => {    const view = await readPullView({ request: makeRequest(), config, ref });
    expect(view.commits).toEqual([
      {
        sha: 'abc123def4567890abcdef',
        shortSha: 'abc123d',
        author: 'Sv Gorbunov',
        summary: 'Remove the temporary exception',
        date: 1789660000000,
      },
      {
        sha: '111222333444555',
        shortSha: '111222333444',
        author: 'Alex Coder',
        summary: 'Add the removal note',
        date: 1789661200000,
      },
    ]);
    expect(view.truncated.commits).toBe(false);

    const overflowing = await readPullView({
      request: makeRequest({ commits: { isLastPage: false, values: COMMITS_BODY.values } }),
      config,
      ref,
    });
    expect(overflowing.truncated.commits).toBe(true);
  });

  it('walks the activities pages and keeps only the comments, replies inside', async () => {
    const view = await readPullView({
      request: makeRequest({
        pages: [
          {
            size: 3,
            limit: 100,
            start: 0,
            isLastPage: false,
            values: [ACTIVITY_NON_COMMENT, ACTIVITY_WITH_COMMENT, ACTIVITY_WITH_ANCHORED_COMMENT],
          },
          { size: 0, limit: 100, start: 3, isLastPage: true, values: [] },
        ],
      }),
      config,
      ref,
    });
    expect(view.comments).toEqual([
      {
        id: 99001,
        author: 'AIR',
        authorSlug: 'ci',
        text: '## Review run info',
        createdAt: 1789664696177,
        resolved: false,
        severity: null,
        // A comment of the overview: nothing to quote by.
        anchor: null,
        replies: [{ author: 'Sv Gorbunov', authorSlug: 'sgorbunov', text: 'Acknowledged.', createdAt: 1789664999000 }],
      },
      {
        id: 99010,
        author: 'Robin Stone',
        authorSlug: 'r.stone',
        text: 'свагера не было?',
        createdAt: 1789750000000,
        resolved: false,
        severity: 'NORMAL',
        // The place in the diff the comment hangs on, path/line/lineType.
        anchor: {
          path: 'autotests/experiments/src/client.py',
          line: 15,
          lineType: 'ADDED',
        },
        replies: [],
      },
    ]);
    expect(view.truncated.comments).toBe(false);
  });

  it('reports the pages cap instead of hiding it', async () => {
    const endlessPage = { size: 1, limit: 100, start: 0, isLastPage: false, values: [ACTIVITY_WITH_COMMENT] };
    const request = vi.fn(async ({ path }) => {
      if (path.endsWith('/activities')) return endlessPage;
      if (path.endsWith('/diff')) return DIFF_BODY;
      if (path.endsWith('/commits')) return COMMITS_BODY;
      return META_BODY;
    });
    const view = await readPullView({ request, config, ref });
    expect(view.truncated.comments).toBe(true);
    // The meta, the diff, the build statuses (the plugin is absent), the
    // commits, and the three activities pages the cap allows — seven GETs,
    // then a stop.
    expect(request).toHaveBeenCalledTimes(7);
  });

  it('propagates the client error kinds, merging them into nothing', async () => {
    const request = vi.fn(async () => {
      throw new BitbucketError('unauthorized', 'the access token was rejected', 401);
    });
    await expect(readPullView({ request, config, ref })).rejects.toMatchObject({ kind: 'unauthorized' });
  });
});
