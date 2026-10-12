/**
 * The pull surface's landing list: the open pulls of the configured token's
 * own account. DC answers them on the dashboard resource — one GET per page,
 * the pulls the user authored or reviews, mixed open and closed and ordered
 * by recent activity. This module keeps the open ones, in the same order,
 * capped at the caller's limit, and says so when the walk stopped early:
 * the list is a memory of what the instance just showed, never a claim of
 * completeness it cannot keep.
 *
 * The number a pull carries in its URL is its `id` here: DC's pull bodies
 * carry no displayId on this resource and the web UI opens pulls by id, so
 * the id is the honest copy of what a user would type or click.
 */

import { z } from 'zod';

import { BitbucketError } from './client.js';

const PAGE_LIMIT = 100;

const personBodySchema = z.object({
  displayName: z.string().nullish(),
  name: z.string().nullish(),
  slug: z.string().nullish(),
});

const dashboardPageSchema = z.object({
  start: z.number().nullish(),
  limit: z.number().nullish(),
  isLastPage: z.boolean().nullish(),
  values: z.array(z.object({
    id: z.number(),
    title: z.string().nullish(),
    state: z.string().nullish(),
    open: z.boolean().nullish(),
    createdDate: z.number().nullish(),
    updatedDate: z.number().nullish(),
    author: z.object({ user: personBodySchema.nullish() }).nullish(),
    fromRef: z.object({
      repository: z.object({
        slug: z.string().nullish(),
        project: z.object({ key: z.string().nullish() }).nullish(),
      }).nullish(),
    }).nullish(),
  })).nullish(),
});

const parseBody = (schema, body, what) => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new BitbucketError('server-error', `${what} did not answer the shape the list reads`);
  }
  return parsed.data;
};

const personNameOf = (person) => person?.displayName || person?.name || person?.slug || null;

/**
 * One dashboard entry into the list row: coordinates, the id the user knows
 * the pull by, the repo it lives in, and the people names. A row whose repo
 * coordinates are missing is dropped rather than guessed — clicking it could
 * not open anything honest anyway.
 */
const entryOf = (entry, origin) => {
  const project = entry.fromRef?.repository?.project?.key ?? null;
  const slug = entry.fromRef?.repository?.slug ?? null;
  if (!project || !slug) return null;
  return {
    number: entry.id,
    url: `${origin}/projects/${project}/repos/${slug}/pull-requests/${entry.id}`,
    title: entry.title ?? `#${entry.id}`,
    state: 'open',
    author: personNameOf(entry.author?.user),
    authorSlug: entry.author?.user?.slug ?? null,
    repo: { project, slug },
    createdAt: entry.createdDate ?? null,
    updatedAt: entry.updatedDate ?? null,
  };
};

/**
 * The open pulls of the token's account, newest activity first. The walk
 * stops at the cap or the pages cap — whichever comes first — and reports
 * `truncated` when open pulls may exist beyond what was returned. The
 * dashboard resource is user-scoped and answers 404 for a user the token
 * cannot see; the error kinds flow through unchanged, so the panel draws
 * its own unconfigured/unauthorized/unreachable states.
 */
export const readOpenPulls = async ({ request, config, limit = 10, maxPages = 3 }) => {
  const origin = config?.origin;
  if (!origin) throw new BitbucketError('unconfigured', 'no Bitbucket instance is configured');

  const pulls = [];
  let truncated = false;
  let start = 0;
  for (let page = 0; page < maxPages && pulls.length < limit; page += 1) {
    const body = parseBody(
      dashboardPageSchema,
      await request({ config, path: '/rest/api/1.0/dashboard/pull-requests', search: `?start=${start}&limit=${PAGE_LIMIT}` }),
      'the pull dashboard',
    );
    const values = body.values ?? [];
    for (const entry of values) {
      if (entry.open !== true) continue;
      const pull = entryOf(entry, origin);
      if (!pull) continue;
      if (pulls.length >= limit) {
        truncated = true;
        break;
      }
      pulls.push(pull);
    }
    if (body.isLastPage !== false || values.length === 0) {
      return { pulls, truncated };
    }
    start += values.length;
    if (pulls.length >= limit) truncated = true;
  }
  return { pulls, truncated };
};
