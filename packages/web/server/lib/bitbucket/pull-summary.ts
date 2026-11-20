/**
 * Bitbucket pull requests mapped into the team board's summary contract —
 * the same shape the GitHub layer answers (`owner`, `repo`, `number`,
 * `state`, `draft`, `title`, `mergeable`, `mergeableState`, `checks`), so
 * the chip renders both providers through one client schema.
 *
 * Mapping decisions, kept honest rather than guessed:
 * - state: DC answers OPEN, MERGED or DECLINED; declined closes without
 *   merging, so it maps to `closed`, merged to `merged`.
 * - draft: DC has no draft flag (that is a Cloud concept) — always false.
 * - mergeable: DC computes conflicts only on a merge dry run the client
 *   does not make here; the answer is `null`, unknown, the same value
 *   GitHub answers while it computes.
 * - checks: the rollup reads the source commit's build statuses.
 *   SUCCESSFUL build statuses map one to one; any FAILED makes the whole
 *   rollup `failure`; otherwise any INPROGRESS makes it `pending`; only
 *   statuses that are all SUCCESSFUL roll up to `success`, and a pull
 *   carrying no builds is `unknown`.
 */

import { z } from 'zod';

import { BitbucketError, type BitbucketInstanceConfig, type BitbucketRequestClient } from './client.js';
import { bitbucketApiPath, bitbucketPullCacheKey, type BitbucketPullRefInput } from './url.js';

/** Слова состояния, которыми вилка называет состояние pull request'а. */
export type BitbucketPullState = 'open' | 'merged' | 'closed';

/** Сводка по проверкам одного коммита. */
export type BitbucketCheckState = 'success' | 'failure' | 'pending' | 'unknown';

export interface BitbucketCheckSummary {
  state: BitbucketCheckState;
  total: number;
}

/** Сводка pull request'а в контракте доски команды — как у слоя GitHub. */
export interface BitbucketPullSummary {
  owner: string;
  repo: string;
  number: number;
  state: BitbucketPullState;
  draft: boolean;
  title: string;
  mergeable: null;
  mergeableState: null;
  checks: BitbucketCheckSummary | null;
}

/**
 * The two REST bodies the summary reads, parsed at this boundary: what the
 * pull itself says and what the build statuses of its latest commit say.
 * Fields beyond the summary's needs are stripped here and never read.
 */
const pullBodySchema = z.object({
  title: z.string().nullish(),
  state: z.string().nullish(),
  fromRef: z.object({
    latestCommit: z.string().nullish(),
  }).nullish(),
});

const buildStatusEntrySchema = z.object({
  state: z.string().nullish(),
});

const buildStatusesBodySchema = z.object({
  values: z.array(buildStatusEntrySchema).nullish(),
});

const parseBody = <Schema extends z.ZodType>(schema: Schema, body: unknown, what: string): z.output<Schema> => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new BitbucketError('server-error', `${what} did not answer the shape the summary reads`);
  }
  return parsed.data;
};

/**
 * The rollup over one commit's build statuses. Shared by the chip's summary
 * and the pull view's checks: one place decides what SUCCESSFUL, FAILED,
 * INPROGRESS and everything else roll up to.
 */
export const summarizeBuildStatuses = (values: readonly (z.infer<typeof buildStatusEntrySchema> | undefined)[] | null | undefined): BitbucketCheckSummary => {
  const list = values ?? [];
  if (list.length === 0) return { state: 'unknown', total: 0 };
  const states = new Set(list.map((entry) => entry?.state ?? ''));
  if (states.has('FAILED')) return { state: 'failure', total: list.length };
  if (states.has('INPROGRESS')) return { state: 'pending', total: list.length };
  if (states.has('UNKNOWN') || list.some((entry) => (entry?.state ?? '') !== 'SUCCESSFUL')) return { state: 'unknown', total: list.length };
  return { state: 'success', total: list.length };
};

/**
 * The provider-state words the fork's surfaces share: DC answers OPEN,
 * MERGED or DECLINED — and anything unknown closes, the same honest
 * reduction the team board's chip reads.
 */
export const pullStateOf = (state: string | null | undefined): BitbucketPullState => {
  if (state === 'OPEN') return 'open';
  if (state === 'MERGED') return 'merged';
  return 'closed';
};

/**
 * One pull's live summary, with its build statuses. The build statuses of
 * the fromRef's latest commit are a second request, so both share the
 * caller's rate: the summary batches them in parallel per ref.
 */
export const readBitbucketPullSummary = async ({ request, config, ref }: {
  request: BitbucketRequestClient;
  config: BitbucketInstanceConfig;
  ref: BitbucketPullRefInput;
}): Promise<BitbucketPullSummary> => {
  const pull = parseBody(pullBodySchema, await request({ config, path: bitbucketApiPath(ref) }), 'the pull request');
  const title = pull.title ?? '';
  const state = pull.state ?? '';
  const latestCommit = pull.fromRef?.latestCommit ?? null;

  let checks: BitbucketCheckSummary | null = null;
  if (latestCommit) {
    try {
      const builds = parseBody(
        buildStatusesBodySchema,
        await request({
          config,
          path: `/rest/build-status/1.0/commits/${encodeURIComponent(latestCommit)}`,
        }),
        'the commit build statuses',
      );
      checks = summarizeBuildStatuses(builds.values);
    } catch (error) {
      // Build statuses are decoration, not the pull's identity: an
      // instance without the build-status plugin answers 404, and the chip
      // must still show the pull's state — unknown checks, known pull.
      if (!(error instanceof BitbucketError) || (error.kind !== 'not-found' && error.kind !== 'server-error')) {
        throw error;
      }
      checks = { state: 'unknown', total: 0 };
    }
  }

  return {
    owner: ref.project,
    repo: ref.slug,
    number: ref.number,
    state: pullStateOf(state),
    draft: false,
    title: title || `#${ref.number}`,
    mergeable: null,
    mergeableState: null,
    checks,
  };
};

/**
 * Summaries for many refs, mirroring the GitHub layer's batch contract:
 * `{ summaries }` with one entry per ref and absentees resolved to null, so
 * one missing number stays unknown instead of failing the whole board.
 * A ref from another instance never travels to the configured one — the
 * coordinates would fetch a stranger's pull — it resolves to null: unknown.
 * A rejected token or an unreachable instance is not a per-ref matter —
 * the error propagates and the caller answers no live state.
 */
export const fetchBitbucketPullSummaries = async ({ request, config, refs }: {
  request: BitbucketRequestClient;
  config: BitbucketInstanceConfig;
  refs: readonly BitbucketPullRefInput[];
}): Promise<{ summaries: Array<{ key: string; summary: BitbucketPullSummary | null }> }> => {
  const settled = await Promise.all(refs.map(async (ref) => {
    if (ref.origin !== config.origin || (ref.context ?? '') !== (config.context ?? '')) {
      return { ref, summary: null };
    }
    try {
      const summary = await readBitbucketPullSummary({ request, config, ref });
      return { ref, summary };
    } catch (error) {
      if (error instanceof BitbucketError && error.kind === 'not-found') return { ref, summary: null };
      throw error;
    }
  }));
  return {
    summaries: settled.map(({ ref, summary }) => ({
      key: bitbucketPullCacheKey(ref),
      summary,
    })),
  };
};
