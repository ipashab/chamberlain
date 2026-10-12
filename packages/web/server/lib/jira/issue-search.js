/**
 * The Jira issue search: the issue surface's quick finder. One GET against
 * the instance's own search — `text ~ "<words>*"`, an exact-key match
 * first when the query itself is an issue key — newest by update, capped
 * at the limit the panel asks for. Still only a read.
 *
 * The query is sanitized here, at this boundary, because JQL is a
 * language: quotes and slashes are dropped before the words ever reach
 * the instance, and what is left are plain words the index answers.
 */

import { z } from 'zod';

import { JiraError } from './client.js';
import { JIRA_ISSUE_KEY_PATTERN, jiraIssueBrowseUrl } from './url.js';

const searchBodySchema = z.object({
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

const parseBody = (schema, body, what) => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new JiraError('server-error', `${what} did not answer the shape the search reads`);
  }
  return parsed.data;
};

/**
 * Plain words for the index: JQL's metacharacters out, the rest kept.
 * An empty answer means there is nothing worth asking the instance.
 */
const sanitizeQueryWords = (rawQuery) =>
  String(rawQuery ?? '')
    .replace(/["\\/:{}[\]()~^]/g, '')
    .trim()
    .slice(0, 100);

/**
 * The search's JQL: the query's words as a text match, or an exact key
 * look-up when the query itself is an issue key. `text ~` covers the
 * summary and the description the way Jira's own quick search does.
 */
const jqlOf = (query) => {
  if (JIRA_ISSUE_KEY_PATTERN.test(query)) {
    return `issuekey = "${query}" OR text ~ "${query}*"`;
  }
  return `text ~ "${query}*"`;
};

/**
 * One search's rows: key, summary, status, type, last update — the list
 * the surface's input lands on once the user stops typing. Rows without
 * a key are dropped, not guessed; the cap is the caller's limit.
 */
export const readJiraIssueSearch = async ({ request, config, query, limit = 10 }) => {
  const words = sanitizeQueryWords(query);
  if (words === '') return { issues: [] };
  const body = parseBody(
    searchBodySchema,
    await request({
      config,
      path: '/rest/api/2/search',
      search: `?jql=${encodeURIComponent(`${jqlOf(words)} ORDER BY updated DESC`)}&maxResults=${limit}&fields=summary,updated,status,issuetype`,
    }),
    'the search',
  );
  return {
    issues: (body.issues ?? [])
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
