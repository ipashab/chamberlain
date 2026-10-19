/**
 * The account's own open issues: the board's landing list. One GET against
 * the instance's own search with a fixed query — the issues assigned to the
 * token's own account and not yet done — newest by update, capped at the
 * limit the caller asks for. The query is fixed here, at this boundary: it
 * is the server's own words, not the words of whoever asks, so JQL's
 * metacharacters never reach the instance from this route. Still only a
 * read.
 */

import { z } from 'zod';

import { JiraError } from './client.js';
import { jiraIssueBrowseUrl } from './url.js';

const mineBodySchema = z.object({
  issues: z.array(z.object({
    key: z.string().nullish(),
    fields: z.object({
      summary: z.string().nullish(),
      updated: z.string().nullish(),
      status: z.object({ name: z.string().nullish() }).nullish(),
      issuetype: z.object({ name: z.string().nullish() }).nullish(),
    }).nullish(),
  })),
});

/**
 * The list's JQL: the token's own account's issues, the not-done ones,
 * newest update first. `assignee = currentUser()` is resolved by the
 * instance itself, so the account's own spelling never travels; the done
 * work stays out — the board lists what there is to do, not the archive.
 */
const MINE_JQL = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC';

/**
 * The board's rows: the same fields a search row carries, the same shape
 * the panel's other lists read, so the one row drawing serves every list.
 */
export const readMyJiraIssues = async ({ request, config, limit = 50 }) => {
  const parsed = mineBodySchema.safeParse(await request({
    config,
    path: '/rest/api/2/search',
    search: `?jql=${encodeURIComponent(MINE_JQL)}&maxResults=${limit}&fields=summary,updated,status,issuetype`,
  }));
  if (!parsed.success) {
    throw new JiraError('server-error', 'the instance did not answer the shape the list reads');
  }
  return {
    issues: (parsed.data.issues ?? [])
      .filter((issue) => issue.key)
      .map((issue) => ({
        key: issue.key,
        url: jiraIssueBrowseUrl(config.origin, issue.key),
        summary: issue.fields?.summary ?? issue.key,
        updated: issue.fields?.updated ?? null,
        statusName: issue.fields?.status?.name ?? null,
        typeName: issue.fields?.issuetype?.name ?? null,
      })),
  };
};
