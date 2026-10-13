/**
 * The Jira issue search: the issue surface's quick finder. One GET against
 * the instance's own search — `text ~ "<words>*"` with an exact-key match
 * first when the query itself is an issue key — newest by update, capped
 * at the limit the panel asks for. Still only a read.
 *
 * The query also speaks four field filters — `assignee:`, `reporter:`,
 * `status:`, `project:` — which become equality clauses ANDed onto the
 * text match. The words are sanitized here, at this boundary, because JQL
 * is a language: quotes and slashes are dropped before anything reaches
 * the instance, and what is left are plain words and clauses the index
 * answers.
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
 * The quick search's own filters: `assignee:`, `reporter:`, `status:` and
 * `project:` in front of a word. A prefix may carry its value the same
 * token (`assignee:ivanov`) or take the words that follow it
 * (`assignee: ivanov`), so both spellings work — a clause's words run
 * until the next prefix. DC's JQL resolves user fields by login and
 * display name alike, so either spelling of a person answers. Project
 * keys are uppercased — the instance's keys are uppercase by
 * construction and DC's JQL matches them that way.
 */
const CLAUSE_PREFIX_PATTERN = /^(assignee|reporter|status|project):(.*)$/i;

/**
 * One query into its two halves: the free words the index answers, and
 * the field clauses the prefixes named. The split is pure because the
 * semantics live here: words carry the text match, clauses narrow it.
 */
const parseQuery = (rawQuery) => {
  const clauses = [];
  const words = [];
  let clause = null;
  for (const token of String(rawQuery ?? '').split(/\s+/)) {
    const match = CLAUSE_PREFIX_PATTERN.exec(token);
    if (match) {
      const value = sanitizeClauseValue(match[2], match[1]);
      clause = { field: match[1].toLowerCase(), buffer: value === '' ? [] : [value] };
      clauses.push(clause);
    } else if (token === '') {
      continue;
    } else if (clause) {
      const value = sanitizeClauseValue(token, clause.field);
      if (value !== '') clause.buffer.push(value);
    } else {
      words.push(token);
    }
  }
  for (const entry of clauses) entry.value = entry.buffer.join(' ');
  return { words, clauses };
};

/** A clause's value: the same metacharacters out, the field's own casing in. */
const sanitizeClauseValue = (rawValue, field) => {
  const value = String(rawValue ?? '').replace(/["\\/:{}[\]()~^]/g, '').trim().slice(0, 100);
  if (value === '') return '';
  return field === 'project' ? value.toUpperCase() : value;
};

/**
 * The search's JQL: the query's words as a text match, the clauses as
 * equality filters ANDed onto it — or, when the query is a bare issue
 * key, the exact look-up with the text match as its fallback, the way it
 * always was. `text ~` covers the summary and the description the way
 * Jira's own quick search does; a clause never widens what the words
 * narrowed.
 */
const jqlOf = (words, clauses) => {
  if (clauses.length === 0 && JIRA_ISSUE_KEY_PATTERN.test(words)) {
    return `issuekey = "${words}" OR text ~ "${words}*"`;
  }
  const parts = [];
  if (words !== '') {
    parts.push(JIRA_ISSUE_KEY_PATTERN.test(words)
      ? `issuekey = "${words}"`
      : `text ~ "${words}*"`);
  }
  for (const clause of clauses) {
    parts.push(`${clause.field} = "${clause.value}"`);
  }
  return parts.join(' AND ');
};

/**
 * One search's rows: key, summary, status, type, last update — the list
 * the surface's input lands on once the user stops typing. Rows without
 * a key are dropped, not guessed; the cap is the caller's limit.
 */
export const readJiraIssueSearch = async ({ request, config, query, limit = 10 }) => {
  const { words: rawWords, clauses: rawClauses } = parseQuery(query);
  const words = sanitizeQueryWords(rawWords.join(' '));
  const clauses = rawClauses.filter((clause) => clause.value !== '');
  if (words === '' && clauses.length === 0) return { issues: [] };
  const body = parseBody(
    searchBodySchema,
    await request({
      config,
      path: '/rest/api/2/search',
      search: `?jql=${encodeURIComponent(`${jqlOf(words, clauses)} ORDER BY updated DESC`)}&maxResults=${limit}&fields=summary,updated,status,issuetype`,
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
