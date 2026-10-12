/**
 * Bitbucket Data Center pull-request URLs: the one address a teammate or
 * the user can paste. A DC instance serves pull requests under
 * `<origin>[/<context path>]/projects/<PROJECT>/repos/<slug>/pull-requests/<id>`
 * — the context path is optional because installs behind a reverse proxy
 * often carry one. The parse answers the coordinates the server needs to
 * call the REST API: origin, context, project, repo slug and the number,
 * with the canonical URL rebuilt from the parts so a hand-edited alias
 * never reaches the API.
 *
 * This module is pure: no fetch, no state — only the URL contract.
 */

import { z } from 'zod';

/**
 * The I/O boundary parse: one non-empty string, trimmed. Everything the
 * pattern then matches is the caller's domain.
 */
const pullUrlTextSchema = z.string().trim().min(1);

const BITBUCKET_PULL_URL_PATTERN = new RegExp(
  '^https?://'
  // Origin without the scheme: a host, optionally with a port.
  + '([A-Za-z0-9._-]+(?::\\d+)?)'
  // An optional context path of plain segments — not "projects", which the
  // URL grammar reserves. The group captures with a leading slash or empty.
  + '((?:/[A-Za-z0-9._~-]+)*)'
  + '/projects/([^/]+)'
  + '/repos/([^/]+)'
  + '/pull-requests/(\\d+)'
  + '/?$',
);

/**
 * A parsed pull request. `project` and `slug` ride under `owner`/`repo`
 * in the team task's stored coordinates; `canonicalUrl` is the address
 * rebuilt from the parts, so aliases and stray trailing slashes are
 * normalized away once, at this boundary.
 */
export const parseBitbucketPullUrl = (value) => {
  const parsedText = pullUrlTextSchema.safeParse(value);
  if (!parsedText.success) return null;
  const raw = parsedText.data;
  const match = BITBUCKET_PULL_URL_PATTERN.exec(raw);
  if (!match) return null;
  const [, host, context, project, slug, id] = match;
  const scheme = raw.slice(0, 5).toLowerCase() === 'https' ? 'https' : 'http';
  const origin = `${scheme}://${host}`;
  const number = Number.parseInt(id, 10);
  if (!Number.isFinite(number) || number < 1) return null;
  const canonicalUrl = `${origin}${context}/projects/${project}/repos/${slug}/pull-requests/${number}`;
  return { scheme, origin, context, project, slug, number, canonicalUrl };
};

/**
 * The REST path for one pull request's main resource, relative to the
 * origin and context: `/rest/api/1.0/projects/<p>/repos/<r>/pull-requests/<id>…`.
 * Project and slug may carry percent escapes; they are used as parsed.
 */
export const bitbucketApiPath = (ref, suffix = '') =>
  `/rest/api/1.0/projects/${ref.project}/repos/${ref.slug}/pull-requests/${ref.number}${suffix}`;

/**
 * One key per pull across the instance, the summary cache's identity:
 * origin and context make two projects with the same coordinates on two
 * instances (or one instance behind a proxy) distinct.
 */
export const bitbucketPullCacheKey = (ref) =>
  `${ref.origin}${ref.context}/projects/${ref.project}/repos/${ref.slug}#${ref.number}`;
