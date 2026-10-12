/**
 * Jira issue references: the two forms a user can paste. A Jira Data Center
 * instance serves issues under `<origin>[/<context path>]/browse/<KEY>`, and
 * a bare `<KEY>` names an issue of the configured instance. The parse answers
 * the coordinates the server needs to call the REST API: origin, context and
 * the issue key, with the canonical URL rebuilt from the parts so a
 * hand-edited alias never reaches the API.
 *
 * This module is pure: no fetch, no state — only the reference contract.
 */

import { z } from 'zod';

/**
 * One issue key as Jira spells it: an uppercase project key, a dash, a
 * number. The cap keeps the pattern honest about project key limits
 * without rejecting shorter real ones — the composer's issue auto-detect
 * reads the same pattern.
 */
export const JIRA_ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9]{0,9}-\d{1,6}$/;

/**
 * The I/O boundary parse: one non-empty string, trimmed. Everything the
 * pattern then matches is the caller's domain.
 */
const refTextSchema = z.string().trim().min(1);

const JIRA_ISSUE_URL_PATTERN = new RegExp(
  '^https?://'
  // Origin without the scheme: a host, optionally with a port.
  + '([A-Za-z0-9._-]+(?::\\d+)?)'
  // An optional context path of plain segments — not "browse", which the
  // URL grammar reserves. The group captures with a leading slash or empty.
  + '((?:/[A-Za-z0-9._~-]+)*)'
  + '/browse/([A-Za-z0-9-]+)'
  + '/?$',
);

/**
 * A parsed issue reference. `origin` and `context` answer `null` and `''`
 * for a bare key — the route then reads the configured instance, and only
 * a full URL can name another one. `canonicalUrl` is the address rebuilt
 * from the parts, so aliases and stray trailing slashes are normalized
 * away once, at this boundary.
 */
export const parseJiraIssueRef = (value) => {
  const parsedText = refTextSchema.safeParse(value);
  if (!parsedText.success) return null;
  const raw = parsedText.data;

  const keyMatch = JIRA_ISSUE_KEY_PATTERN.exec(raw);
  if (keyMatch) {
    return { origin: null, context: '', key: raw, canonicalUrl: null };
  }

  const match = JIRA_ISSUE_URL_PATTERN.exec(raw);
  if (!match) return null;
  const [, host, context, key] = match;
  if (!JIRA_ISSUE_KEY_PATTERN.test(key)) return null;
  const scheme = raw.slice(0, 5).toLowerCase() === 'https' ? 'https' : 'http';
  const origin = `${scheme}://${host}`;
  const canonicalUrl = `${origin}${context}/browse/${key}`;
  return { scheme, origin, context, key, canonicalUrl };
};

/**
 * The browse address of one issue on an instance. Jira's own pages link
 * issues this way; the viewer opens the same URL in a browser tab.
 */
export const jiraIssueBrowseUrl = (origin, key) => `${origin}/browse/${key}`;
