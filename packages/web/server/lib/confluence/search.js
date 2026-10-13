/**
 * The Confluence page search: the reader surface's quick finder. One GET
 * against the instance's own content search — the words as a CQL text
 * match, pages only — newest by last update, capped at the limit the
 * panel asks for. Still only a read.
 *
 * The query is sanitized at this boundary, the same contract the Jira
 * search holds: CQL is a language, so its metacharacters are dropped
 * before the words ever reach the instance, and what is left are plain
 * words the index answers.
 */

import { z } from 'zod';

import { ConfluenceError } from './client.js';

const searchBodySchema = z.object({
  results: z
    .array(
      z.object({
        id: z.union([z.string(), z.number()]),
        title: z.string().nullish(),
        space: z
          .object({
            key: z.string().nullish(),
            name: z.string().nullish(),
          })
          .nullish(),
        lastUpdated: z.string().nullish(),
        _links: z.object({ webui: z.string().nullish() }).nullish(),
      }),
    )
    .nullish(),
});

const parseBody = (schema, body, what) => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ConfluenceError('server-error', `${what} did not answer the shape the search reads`);
  }
  return parsed.data;
};

/**
 * Plain words for the index: CQL's metacharacters out, the rest kept. An
 * empty answer means there is nothing worth asking the instance.
 */
const sanitizeQueryWords = (rawQuery) =>
  String(rawQuery ?? '')
    .replace(/["\\/:{}[\]()~^+\-!*<>=]/g, '')
    .trim()
    .slice(0, 100);

/**
 * One search's rows: id, title, space, last update — the list the reader's
 * input lands on once the user stops typing. Rows without a usable id are
 * dropped, not guessed; the cap is the caller's limit.
 */
export const readConfluenceSearch = async ({ request, config, query, limit = 10 }) => {
  const words = sanitizeQueryWords(query);
  if (words === '') return { results: [] };
  const cql = `type=page and (title~"${words}*" or text~"${words}*")`;
  const body = parseBody(
    searchBodySchema,
    await request({
      config,
      path: '/rest/api/content/search',
      search: `?cql=${encodeURIComponent(cql)}&limit=${limit}`,
    }),
    'the search',
  );
  return {
    results: (body.results ?? [])
      .filter((entry) => String(entry.id ?? '').trim() !== '')
      .map((entry) => {
        const id = String(entry.id);
        const webui = entry._links?.webui ?? null;
        return {
          id,
          title: entry.title ?? id,
          space: {
            key: entry.space?.key ?? null,
            name: entry.space?.name ?? entry.space?.key ?? null,
          },
          lastUpdated: entry.lastUpdated ?? null,
          url: webui ? `${config.origin}${webui}` : null,
        };
      }),
  };
};
