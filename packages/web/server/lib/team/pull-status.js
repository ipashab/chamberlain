/**
 * The board's pull-request summaries: the live state of every task carrying
 * a PR link, keyed by task id for the panel.
 *
 * Two providers answer, one contract each. GitHub refs flow through the
 * GraphQL summary layer exactly as before; Bitbucket Data Center refs
 * flow through the fork's own REST client, one pull per request, with the
 * instance's configured origin and token. A board that carries only GitHub
 * pulls behaves bit for bit as it always did — including the
 * 'disconnected' / 'unavailable' envelope — because the GitHub path is
 * the old path. Bitbucket-only boards never touch GitHub state: a missing
 * GitHub account cannot make them say 'disconnected'. Mixed boards answer
 * 'ok' per task: one provider's failure leaves its own tasks unknown and
 * the other's live.
 *
 * The board refetches on every team event, and a busy team moves several
 * times a minute — but a PR's state does not. Answers are cached per
 * pull for the TTL window, so the refetch that follows a mailbox message
 * costs the cache, not the providers. The module owns no route;
 * `routes.js` registers it, because the account, token and rate-limit
 * state live in the provider modules, not here.
 */

import { z } from 'zod';

const SUMMARY_TTL_MS = 60_000;

const now = () => Date.now();

/**
 * The pull-valid shapes the route will send to the providers: whatever the
 * service wrote. Serialized state edited by hand or a value from an older
 * shape does not reach the API — it is parsed here, at the boundary, and a
 * value that does not parse is skipped, not guessed at. GitHub pulls
 * stored before the Bitbucket support carry no `provider` — `github` is
 * the default, so old boards keep their chips exactly as they were.
 */
const githubPullRefSchema = z.object({
  provider: z.literal('github').optional(),
  owner: z.string().min(1),
  repo: z.string().min(1),
  number: z.number().int().positive(),
  url: z.string(),
});

const bitbucketPullRefSchema = z.object({
  provider: z.literal('bitbucket'),
  origin: z.string().min(1),
  context: z.string(),
  project: z.string().min(1),
  slug: z.string().min(1),
  number: z.number().int().positive(),
  url: z.string(),
});

const parsedPullRef = (pull) => {
  const schema = pull?.provider === 'bitbucket' ? bitbucketPullRefSchema : githubPullRefSchema;
  const result = schema.safeParse(pull);
  return result.success ? result.data : null;
};

const cacheKeyOf = (pull) => (pull.provider === 'bitbucket'
  ? `bb:${pull.origin}${pull.context}/projects/${pull.project}/repos/${pull.slug}#${pull.number}`
  : `gh:${pull.owner}/${pull.repo}#${pull.number}`);

const createTeamPullStatus = ({
  loadGitHub = () => import('../github/index.js'),
  loadGitHubSummaries = () => import('../github/pr-summaries.js'),
  loadGitHubRateLimit = () => import('../github/rate-limit.js'),
  loadBitbucketConfig = async () => null,
  loadBitbucketClient = () => import('../bitbucket/client.js'),
  loadBitbucketSummaries = () => import('../bitbucket/pull-summary.js'),
} = {}) => {
  // Per-instance: summaries live exactly as long as the wired route does.
  const cache = new Map();

  /** The cache's view of one provider's refs: hits in `fresh`, misses in `stale`. */
  const splitByCache = (refs) => {
    const fresh = new Map();
    const stale = [];
    const freshAt = now();
    for (const [taskId, pull] of refs) {
      const key = cacheKeyOf(pull);
      const hit = cache.get(key);
      if (hit && freshAt - hit.at < SUMMARY_TTL_MS) {
        fresh.set(taskId, hit.summary);
      } else {
        stale.push({ taskId, pull, key, freshAt });
      }
    }
    return { fresh, stale };
  };

  /** Store one answer for its task and remember it under the pull's key. */
  const remember = (fresh, { taskId, key, freshAt }, summary) => {
    if (cache.size > 200) cache.clear();
    cache.set(key, { at: freshAt, summary });
    fresh.set(taskId, summary);
  };

  /**
   * GitHub's answers. The result is the provider's envelope — 'ok' with the
   * per-task map, or 'disconnected' / 'unavailable' with none — exactly the
   * single-provider read answered before Bitbucket existed.
   */
  const readGithub = async (refs) => {
    const { fresh, stale } = splitByCache(refs);
    if (stale.length === 0) return { status: 'ok', fresh };

    const [github, summariesModule, rateLimit] = await Promise.all([
      loadGitHub(),
      loadGitHubSummaries(),
      loadGitHubRateLimit(),
    ]);
    if (rateLimit.isGitHubRateLimited()) return { status: 'unavailable' };
    const octokit = await github.getOctokitOrNull();
    if (!octokit) return { status: 'disconnected' };

    try {
      const { summaries } = await summariesModule.fetchPrSummaries({
        octokit,
        refs: stale.map(({ pull }) => ({ owner: pull.owner, repo: pull.repo, number: pull.number })),
      });
      const byRef = new Map(summaries.map((summary) => [cacheKeyOf({ owner: summary.owner, repo: summary.repo, number: summary.number }), summary]));
      // Absence means unknown, never closed: an unresolved PR is cached as
      // null so one missing number cannot refetch on every event.
      for (const entry of stale) remember(fresh, entry, byRef.get(entry.key) ?? null);
      return { status: 'ok', fresh };
    } catch (error) {
      if ((error?.status ?? error?.response?.status) === 401) return { status: 'disconnected' };
      if (summariesModule.isGraphqlRateLimitError?.(error) || rateLimit.isGitHubRateLimitError?.(error)) {
        // The shared cooldown also holds back every other GitHub read.
        rateLimit.noteGitHubRateLimit(error);
        return { status: 'unavailable' };
      }
      throw error;
    }
  };

  /**
   * Bitbucket's answers, always 'ok'-shaped: every task maps to its summary
   * or to null — unknown — because the envelope's provider-wide words are
   * the GitHub path's, carried up only by the GitHub-only board. No
   * configured instance means no answers and no cached nulls either: the
   * moment the settings card saves a token, the next event goes live.
   */
  const readBitbucket = async (refs) => {
    const { fresh, stale } = splitByCache(refs);
    if (stale.length === 0) return { fresh };

    const [configState, clientModule, summariesModule] = await Promise.all([
      loadBitbucketConfig(),
      loadBitbucketClient(),
      loadBitbucketSummaries(),
    ]);
    const instance = configState?.instance;
    if (!instance?.origin || !instance?.token) {
      for (const entry of stale) fresh.set(entry.taskId, null);
      return { fresh };
    }
    try {
      const { summaries } = await summariesModule.fetchBitbucketPullSummaries({
        request: clientModule.createBitbucketRequest(),
        config: { origin: instance.origin, token: instance.token, verifySsl: instance.verifySsl },
        refs: stale.map(({ pull }) => pull),
      });
      // The summary module's keys are the pulls' own; this cache's carry
      // the provider prefix — the two meet once, here at the seam.
      const byKey = new Map(summaries.map((entry) => [`bb:${entry.key}`, entry.summary]));
      for (const entry of stale) remember(fresh, entry, byKey.get(entry.key) ?? null);
    } catch (error) {
      // A rejected token or an unreachable instance is the provider's
      // whole board down, not one pull's: answer unknown for every stale
      // task and keep the cache clean for the fixed connection.
      console.warn('[team] bitbucket pull summaries failed:', error?.message ?? error);
      for (const entry of stale) fresh.set(entry.taskId, null);
    }
    return { fresh };
  };

  return {
  /**
   * Live summaries for the team's tasks. `status` follows the tracked-items
   * contract: 'ok' with a per-task map, or 'disconnected' / 'unavailable'
   * with no map — the panel renders the chip as unknown rather than failing
   * the board it decorates. Tasks without a PR are absent from the map.
   */
  read: async (tasks) => {
    const githubRefs = new Map();
    const bitbucketRefs = new Map();
    for (const task of tasks ?? []) {
      const ref = parsedPullRef(task?.pull);
      if (!ref) continue;
      if (ref.provider === 'bitbucket') bitbucketRefs.set(task.taskId, ref);
      else githubRefs.set(task.taskId, ref);
    }
    if (githubRefs.size === 0 && bitbucketRefs.size === 0) return { status: 'ok', summaries: {} };

    // The GitHub-only board keeps the exact old shape, envelope included.
    if (bitbucketRefs.size === 0) {
      const github = await readGithub(githubRefs);
      if (github.status !== 'ok') return { status: github.status };
      return { status: 'ok', summaries: Object.fromEntries(github.fresh) };
    }

    const [bitbucket, github] = await Promise.all([
      readBitbucket(bitbucketRefs),
      githubRefs.size > 0 ? readGithub(githubRefs) : { status: 'ok', fresh: new Map() },
    ]);
    const summaries = Object.fromEntries(bitbucket.fresh);
    if (github.status === 'ok') {
      for (const [taskId, summary] of github.fresh) summaries[taskId] = summary;
    } else {
      // The whole GitHub provider is down on a mixed board: its tasks stay
      // unknown, the same answer the chip gives an unresolved pull.
      for (const [taskId] of githubRefs) summaries[taskId] = null;
    }
    return { status: 'ok', summaries };
  },
  };
};

export { createTeamPullStatus };
