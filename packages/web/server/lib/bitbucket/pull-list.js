/**
 * The pull surface's landing list: the pulls of the configured token's
 * own account. DC answers them on the dashboard resource — one GET per page,
 * the pulls the user authored or reviews, mixed open and closed and ordered
 * by recent activity. This module keeps them all in that order: the open
 * ones capped at the caller's limit, the closed ones riding along up to the
 * same cap so the panel can filter by state — with the same state words the
 * team board's summary uses — and a `truncated` that still speaks only about
 * the open ones the walk never reached. The list is a memory of what the
 * instance just showed, never a claim of completeness it cannot keep.
 *
 * The number a pull carries in its URL is its `id` here: DC's pull bodies
 * carry no displayId on this resource and the web UI opens pulls by id, so
 * the id is the honest copy of what a user would type or click.
 */

import { z } from 'zod';

import { BitbucketError } from './client.js';
import { pullStateOf } from './pull-summary.js';

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
    state: pullStateOf(entry.state ?? (entry.open === false ? 'MERGED' : 'OPEN')),
    author: personNameOf(entry.author?.user),
    authorSlug: entry.author?.user?.slug ?? null,
    repo: { project, slug },
    createdAt: entry.createdDate ?? null,
    updatedAt: entry.updatedDate ?? null,
  };
};

/**
 * The token's own pulls, newest activity first. The walk stops when the
 * open ones reach the cap or the pages cap — whichever comes first — and
 * reports `truncated` when open pulls may exist beyond what was returned.
 * Closed pulls ride along in the same activity order, up to a cap of their
 * own, so the panel's state filter has something to filter; a closed pull
 * seen past its cap is simply not kept — `truncated` never speaks about
 * them. The dashboard resource is user-scoped and answers 404 for a user
 * the token cannot see; the error kinds flow through unchanged, so the
 * panel draws its own unconfigured/unauthorized/unreachable states.
 */
export const readDashboardPulls = async ({ request, config, limit = 10, maxPages = 3 }) => {
  const origin = config?.origin;
  if (!origin) throw new BitbucketError('unconfigured', 'no Bitbucket instance is configured');

  const pulls = [];
  const seen = new Set();
  let openCount = 0;
  let closedCount = 0;
  let truncated = false;
  let start = 0;
  for (let page = 0; page < maxPages && openCount < limit; page += 1) {
    const body = parseBody(
      dashboardPageSchema,
      await request({ config, path: '/rest/api/1.0/dashboard/pull-requests', search: `?start=${start}&limit=${PAGE_LIMIT}` }),
      'the pull dashboard',
    );
    const values = body.values ?? [];
    for (const entry of values) {
      const pull = entryOf(entry, origin);
      if (!pull) continue;
      if (pull.state === 'open') {
        if (openCount >= limit) {
          truncated = true;
          break;
        }
        openCount += 1;
        pulls.push(pull);
      } else if (closedCount < limit && !seen.has(pull.url)) {
        seen.add(pull.url);
        closedCount += 1;
        pulls.push(pull);
      }
    }
    if (truncated) break;
    if (body.isLastPage !== false || values.length === 0) {
      return { pulls, truncated };
    }
    start += values.length;
    if (openCount >= limit) truncated = true;
  }
  return { pulls, truncated };
};
