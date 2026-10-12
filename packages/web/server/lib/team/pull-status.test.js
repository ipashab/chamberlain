import { describe, expect, it, vi } from 'vitest';

import { createTeamPullStatus } from './pull-status.js';

const pullOf = (number) => ({ owner: 'octo', repo: 'repo', number, url: `https://github.com/octo/repo/pull/${number}` });

const makeModules = ({ summaries, octokit = {}, limited = false, rateLimitError = false, refuse = false } = {}) => {
  const fetchPrSummaries = vi.fn(async ({ refs }) => ({
    summaries: (summaries ?? refs.map((ref) => ({ ...ref, state: 'open', draft: false, title: `PR ${ref.number}`, mergeable: null, checks: null }))),
    issueSummaries: [],
  }));
  if (refuse) {
    fetchPrSummaries.mockImplementation(async () => { throw new Error('network down'); });
  } else if (rateLimitError) {
    fetchPrSummaries.mockImplementation(async () => { throw Object.assign(new Error('secondary rate limit'), { isRateLimit: true }); });
  }
  const noteGitHubRateLimit = vi.fn();
  return {
    fetchPrSummaries,
    noteGitHubRateLimit,
    loadGitHub: async () => ({ getOctokitOrNull: async () => octokit }),
    loadGitHubSummaries: async () => ({ fetchPrSummaries, isGraphqlRateLimitError: (error) => error?.isRateLimit === true }),
    loadGitHubRateLimit: async () => ({
      isGitHubRateLimited: () => limited,
      isGitHubRateLimitError: () => rateLimitError,
      noteGitHubRateLimit,
    }),
  };
};

const taskWithPull = (taskId, number) => ({ taskId, pull: pullOf(number) });

describe('createTeamPullStatus', () => {
  it('answers live summaries keyed by task id', async () => {
    const modules = makeModules();
    const result = await createTeamPullStatus(modules).read([taskWithPull('task_1', 7), { taskId: 'task_2', pull: null }]);
    expect(result.status).toBe('ok');
    expect(Object.keys(result.summaries)).toEqual(['task_1']);
    expect(result.summaries.task_1).toMatchObject({ owner: 'octo', repo: 'repo', number: 7, state: 'open' });
  });

  it('serves the second burst from the cache, not GitHub', async () => {
    const modules = makeModules();
    const pullStatus = createTeamPullStatus(modules);
    await pullStatus.read([taskWithPull('task_1', 7)]);
    await pullStatus.read([taskWithPull('task_1', 7)]);
    expect(modules.fetchPrSummaries).toHaveBeenCalledTimes(1);
  });

  it('keeps an unresolved PR unknown instead of refetching every event', async () => {
    const modules = makeModules({ summaries: [] });
    const pullStatus = createTeamPullStatus(modules);
    const first = await pullStatus.read([taskWithPull('task_1', 404)]);
    expect(first.status).toBe('ok');
    expect(first.summaries.task_1).toBeNull();
    const second = await pullStatus.read([taskWithPull('task_1', 404)]);
    expect(second.summaries.task_1).toBeNull();
    expect(modules.fetchPrSummaries).toHaveBeenCalledTimes(1);
  });

  it('fetches a pull again once the TTL window has passed', async () => {
    vi.useFakeTimers();
    try {
      const modules = makeModules();
      const pullStatus = createTeamPullStatus(modules);
      await pullStatus.read([taskWithPull('task_1', 7)]);
      vi.advanceTimersByTime(61_000);
      await pullStatus.read([taskWithPull('task_1', 7)]);
      expect(modules.fetchPrSummaries).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says disconnected without an account and unavailable under the rate limit', async () => {
    await expect(createTeamPullStatus(makeModules({ octokit: null })).read([taskWithPull('task_1', 7)]))
      .resolves.toEqual({ status: 'disconnected' });
    await expect(createTeamPullStatus(makeModules({ limited: true })).read([taskWithPull('task_1', 7)]))
      .resolves.toEqual({ status: 'unavailable' });
  });

  it('records the shared cooldown when the provider reports the rate limit', async () => {
    const modules = makeModules({ rateLimitError: true });
    await expect(createTeamPullStatus(modules).read([taskWithPull('task_1', 7)]))
      .resolves.toEqual({ status: 'unavailable' });
    expect(modules.noteGitHubRateLimit).toHaveBeenCalledTimes(1);
  });

  it('asks for nothing when no task carries a usable pull', async () => {
    const modules = makeModules();
    const pullStatus = createTeamPullStatus(modules);
    await expect(pullStatus.read([{ taskId: 'task_1', pull: null }])).resolves.toEqual({ status: 'ok', summaries: {} });
    await expect(pullStatus.read([])).resolves.toEqual({ status: 'ok', summaries: {} });
    expect(modules.fetchPrSummaries).not.toHaveBeenCalled();
  });

  it('ignores malformed pull refs rather than sending them to the provider', async () => {
    const modules = makeModules();
    const result = await createTeamPullStatus(modules).read([
      { taskId: 'task_1', pull: { owner: 'octo', repo: 'repo', number: 'seven' } },
      { taskId: 'task_2', pull: { owner: '', repo: 'repo', number: 7 } },
    ]);
    expect(result.status).toBe('ok');
    expect(result.summaries).toEqual({});
    expect(modules.fetchPrSummaries).not.toHaveBeenCalled();
  });

  it('propagates an unexpected provider failure', async () => {
    const modules = makeModules({ refuse: true });
    await expect(createTeamPullStatus(modules).read([taskWithPull('task_1', 7)])).rejects.toThrow('network down');
  });
});

const bbPullOf = (number) => ({
  provider: 'bitbucket',
  origin: 'https://bitbucket.example.com',
  context: '',
  project: 'OC',
  slug: 'core',
  number,
  url: `https://bitbucket.example.com/projects/OC/repos/core/pull-requests/${number}`,
});

const bbConfig = { origin: 'https://bitbucket.example.com', token: 'BBDC-test', verifySsl: true };

const makeBitbucket = ({ configured = true, refuse = false } = {}) => {
  let fetches = 0;
  const loadBitbucketSummaries = async () => ({
    fetchBitbucketPullSummaries: async ({ refs }) => {
      fetches += 1;
      if (refuse) throw Object.assign(new Error('token rejected'), { kind: 'unauthorized' });
      return {
        summaries: refs.map((ref) => ({
          key: `https://bitbucket.example.com/projects/${ref.project}/repos/${ref.slug}#${ref.number}`,
          summary: {
            owner: ref.project,
            repo: ref.slug,
            number: ref.number,
            state: 'open',
            draft: false,
            title: `PR ${ref.number}`,
            mergeable: null,
            mergeableState: null,
            checks: { state: 'success', total: 1 },
          },
        })),
      };
    },
  });
  return {
    modules: {
      loadBitbucketConfig: async () => ({ instance: configured ? bbConfig : null }),
      loadBitbucketClient: async () => ({ createBitbucketRequest: () => async () => ({}) }),
      loadBitbucketSummaries,
    },
    fetchCount: () => fetches,
  };
};

describe('createTeamPullStatus: Bitbucket Data Center refs', () => {
  it('answers live without a GitHub account, because the board never asks GitHub', async () => {
    const bb = makeBitbucket();
    const modules = { ...makeModules({ octokit: null }), ...bb.modules };
    const result = await createTeamPullStatus(modules).read([{ taskId: 'task_1', pull: bbPullOf(7) }]);
    expect(result.status).toBe('ok');
    expect(result.summaries.task_1).toMatchObject({ owner: 'OC', repo: 'core', number: 7, state: 'open' });
  });

  it('leaves an unconfigured instance unknown, without caching it that way', async () => {
    const bb = makeBitbucket({ configured: false });
    const pullStatus = createTeamPullStatus({ ...makeModules(), ...bb.modules });
    const first = await pullStatus.read([{ taskId: 'task_1', pull: bbPullOf(7) }]);
    expect(first.status).toBe('ok');
    expect(first.summaries.task_1).toBeNull();

    // The moment a connection exists, the next event goes live — the
    // unconfigured null was never written to the summary cache.
    const configured = makeBitbucket();
    const live = createTeamPullStatus({ ...makeModules(), ...configured.modules });
    const second = await live.read([{ taskId: 'task_1', pull: bbPullOf(7) }]);
    expect(second.summaries.task_1).toMatchObject({ state: 'open' });
    expect(configured.fetchCount()).toBe(1);
  });

  it('serves the second burst from the cache too', async () => {
    const bb = makeBitbucket();
    const pullStatus = createTeamPullStatus({ ...makeModules(), ...bb.modules });
    await pullStatus.read([{ taskId: 'task_1', pull: bbPullOf(7) }]);
    await pullStatus.read([{ taskId: 'task_1', pull: bbPullOf(7) }]);
    expect(bb.fetchCount()).toBe(1);
  });

  it('answers unknown for its own tasks when the instance rejects the token', async () => {
    const bb = makeBitbucket({ refuse: true });
    const result = await createTeamPullStatus({ ...makeModules(), ...bb.modules }).read([{
      taskId: 'task_1',
      pull: bbPullOf(7),
    }]);
    expect(result.status).toBe('ok');
    expect(result.summaries.task_1).toBeNull();
  });

  it('keeps a mixed board per provider: Bitbucket stays live while GitHub is disconnected', async () => {
    const bb = makeBitbucket();
    const modules = { ...makeModules({ octokit: null }), ...bb.modules };
    const result = await createTeamPullStatus(modules).read([
      { taskId: 'task_bb', pull: bbPullOf(7) },
      taskWithPull('task_gh', 42),
    ]);
    expect(result.status).toBe('ok');
    expect(result.summaries.task_bb).toMatchObject({ state: 'open' });
    expect(result.summaries.task_gh).toBeNull();
  });

  it('skips a Bitbucket ref that lost its instance coordinates', async () => {
    const bb = makeBitbucket();
    const modules = { ...makeModules(), ...bb.modules };
    const result = await createTeamPullStatus(modules).read([
      { taskId: 'task_1', pull: { ...bbPullOf(7), origin: '' } },
    ]);
    expect(result.status).toBe('ok');
    expect(result.summaries).toEqual({});
    expect(bb.fetchCount()).toBe(0);
  });

  it('keeps the GitHub-only board identical to the single-provider answer', async () => {
    const bb = makeBitbucket();
    const modules = { ...makeModules({ octokit: null }), ...bb.modules };
    await expect(createTeamPullStatus(modules).read([taskWithPull('task_gh', 42)]))
      .resolves.toEqual({ status: 'disconnected' });
    expect(bb.fetchCount()).toBe(0);
  });
});
