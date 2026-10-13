/**
 * The Confluence page view: one GET that answers everything the reader
 * panel shows — the rendered body, the space and version it belongs to,
 * its web URL — in one shape the client schema can hold.
 *
 * The body arrives as the instance rendered it (`body.view`); panel-side
 * purifying narrows it the way the Jira description's HTML is narrowed.
 * A body past this many characters is cut with the honest `truncated`
 * flag, so a giant page never smuggles unbounded bytes into a reader.
 *
 * Rows answer the identity the reader needs and nothing more: no storage
 * XHTML, no metadata the panel cannot draw.
 */

import { z } from 'zod';

import { ConfluenceError } from './client.js';

// The body's honest ceiling: past this the reader shows what fits and
// says so, the same deal every capped material in the fork offers.
const BODY_CAP = 200_000;

const pageBodySchema = z.object({
  id: z.union([z.string(), z.number()]),
  title: z.string().nullish(),
  space: z
    .object({
      key: z.string().nullish(),
      name: z.string().nullish(),
    })
    .nullish(),
  version: z
    .object({
      number: z.number().nullish(),
      when: z.string().nullish(),
    })
    .nullish(),
  history: z
    .object({
      lastUpdated: z
        .object({
          by: z
            .object({
              displayName: z.string().nullish(),
              username: z.string().nullish(),
            })
            .nullish(),
          when: z.string().nullish(),
        })
        .nullish(),
    })
    .nullish(),
  body: z
    .object({
      view: z.object({ value: z.string().nullish() }).nullish(),
    })
    .nullish(),
  _links: z.object({ webui: z.string().nullish() }).nullish(),
});

const parseBody = (schema, body, what) => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ConfluenceError('server-error', `${what} did not answer the shape the page view reads`);
  }
  return parsed.data;
};

/**
 * One page's full read. `pageId` is the page's numeric id — the same id
 * the instance's own URL carries after `/pages/`. The page's web URL is
 * the origin plus the `_links.webui` path the instance names; the id the
 * answer carries back is the caller's own spelling, so the reader's
 * record stays keyed by what was asked.
 */
export const readConfluencePage = async ({ request, config, pageId }) => {
  const id = String(pageId ?? '').trim();
  if (!/^\d+$/.test(id)) {
    throw new ConfluenceError('not-found', 'a page id is a number');
  }
  const page = parseBody(
    pageBodySchema,
    await request({
      config,
      path: `/rest/api/content/${id}`,
      search: '?expand=body.view,space,version,history.lastUpdated',
    }),
    'the page',
  );

  const body = page.body?.view?.value ?? '';
  const truncated = body.length > BODY_CAP;
  const webui = page._links?.webui ?? `/spaces/${page.space?.key ?? ''}/pages/${id}`;
  return {
    id,
    title: page.title ?? id,
    space: {
      key: page.space?.key ?? null,
      name: page.space?.name ?? page.space?.key ?? null,
    },
    version: page.version?.number ?? null,
    updatedAt: page.version?.when ?? page.history?.lastUpdated?.when ?? null,
    updatedBy: page.history?.lastUpdated?.by?.displayName ?? page.history?.lastUpdated?.by?.username ?? null,
    url: `${config.origin}${webui}`,
    html: truncated ? body.slice(0, BODY_CAP) : body,
    truncated,
  };
};
