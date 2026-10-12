import { describe, expect, it } from 'vitest';

import { bitbucketApiPath, bitbucketPullCacheKey, parseBitbucketPullUrl } from './url.js';

describe('parseBitbucketPullUrl', () => {
  it('parses the plain instance form and rebuilds the canonical URL', () => {
    expect(parseBitbucketPullUrl('https://bitbucket.example.com/projects/OC/repos/core/pull-requests/42'))
      .toEqual({
        scheme: 'https',
        origin: 'https://bitbucket.example.com',
        context: '',
        project: 'OC',
        slug: 'core',
        number: 42,
        canonicalUrl: 'https://bitbucket.example.com/projects/OC/repos/core/pull-requests/42',
      });
  });

  it('parses a reverse-proxy context path', () => {
    expect(parseBitbucketPullUrl('https://ci.example.com/bitbucket/projects/TEAM/repos/play/pull-requests/7/'))
      .toMatchObject({ context: '/bitbucket', project: 'TEAM', slug: 'play', number: 7 });
  });

  it('accepts an http origin on any host the instance serves', () => {
    expect(parseBitbucketPullUrl('http://bitbucket.internal/projects/a/repos/b/pull-requests/1'))
      .toMatchObject({ scheme: 'http', origin: 'http://bitbucket.internal', number: 1 });
  });

  it('keeps project keys with the characters DC allows in them', () => {
    expect(parseBitbucketPullUrl('https://bb.example.com/projects/~pav.ivanov/repos/my.repo/pull-requests/3'))
      .toMatchObject({ project: '~pav.ivanov', slug: 'my.repo', number: 3 });
  });

  it('refuses everything that is not a pull-request URL', () => {
    expect(parseBitbucketPullUrl('')).toBeNull();
    expect(parseBitbucketPullUrl(null)).toBeNull();
    expect(parseBitbucketPullUrl('https://github.com/octo/repo/pull/42')).toBeNull();
    expect(parseBitbucketPullUrl('https://bitbucket.example.com/projects/OC/repos/core')).toBeNull();
    expect(parseBitbucketPullUrl('https://bitbucket.example.com/projects/OC/repos/core/pull-requests/abc')).toBeNull();
    expect(parseBitbucketPullUrl('https://bitbucket.example.com/projects/OC/repos/core/pull-requests/0')).toBeNull();
  });

  it('reads a doubled projects segment as a context path, the greedy truth of the grammar', () => {
    // A proxy context that is itself named "projects" owns the first
    // segment; the coordinates after it are the pull's. The parser picks
    // the reading that consumes the most context, which keeps every real
    // pull unique even behind such a proxy.
    expect(parseBitbucketPullUrl('https://bb.example.com/projects/projects/OC/repos/core/pull-requests/1'))
      .toMatchObject({ context: '/projects', project: 'OC', slug: 'core', number: 1 });
  });

  it('keeps the project named projects when no context path exists', () => {
    expect(parseBitbucketPullUrl('https://bb/projects/projects/repos/core/pull-requests/1'))
      .toMatchObject({ origin: 'https://bb', context: '', project: 'projects', slug: 'core', number: 1 });
  });
});

describe('bitbucketApiPath', () => {
  it('builds the REST path for the pull and its sub-resources', () => {
    const ref = parseBitbucketPullUrl('https://bb/projects/OC/repos/core/pull-requests/42');
    expect(bitbucketApiPath(ref)).toBe('/rest/api/1.0/projects/OC/repos/core/pull-requests/42');
    expect(bitbucketApiPath(ref, '/diff')).toBe('/rest/api/1.0/projects/OC/repos/core/pull-requests/42/diff');
  });
});

describe('bitbucketPullCacheKey', () => {
  it('separates the same coordinates on different instances', () => {
    const one = parseBitbucketPullUrl('https://bb.one/projects/OC/repos/core/pull-requests/1');
    const two = parseBitbucketPullUrl('https://bb.two/projects/OC/repos/core/pull-requests/1');
    expect(bitbucketPullCacheKey(one)).not.toBe(bitbucketPullCacheKey(two));
    expect(bitbucketPullCacheKey(one)).toBe('https://bb.one/projects/OC/repos/core#1');
  });
});
