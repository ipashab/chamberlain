/**
 * Jira routes for the client — the settings card's backend and the
 * read-only issue view's.
 *
 * The card reads, writes and drops one Data Center connection: an instance
 * origin, a personal access token and the instance's TLS policy — the same
 * shape the Bitbucket card uses, because it is the same kind of machine.
 * The token never travels back: `readPublic` answers the fact of it, and
 * every answer here carries `{ configured, origin?, hasToken?, verifySsl? }`
 * so the card can draw itself from one shape.
 *
 * A save that carries a full connection follows with a connection check —
 * one lightweight GET the token must survive (`/rest/api/2/myself`) — so
 * the card can say "the token was rejected" at the moment the user pastes
 * it, not when a viewer shows its first failure later. A save with no
 * token (an origin edit or the TLS switch) skips the check.
 *
 * The issue view is the viewer's backend: one GET that answers the issue's
 * full read — details, rendered description, comments, links, subtasks,
 * attachments, watchers. Reading is all it ever does, and an issue named
 * by a full URL must belong to the configured instance — coordinates from
 * another instance resolve to an explicit wrong-instance answer, never a
 * silent read of a stranger's issue.
 *
 * The search is the surface's quick finder; the avatar route proxies the
 * instance's own images with the token the browser never has.
 */

import express from 'express';
import { z } from 'zod';

import { JiraError, createJiraAvatarRequest, createJiraRequest } from './client.js';
import { readJiraIssueSearch } from './issue-search.js';
import { readJiraIssueView } from './issue-view.js';
import { parseJiraIssueRef } from './url.js';

// This server parses JSON per route, not globally; the body parser is
// attached to the route that reads req.body.
const jsonBody = express.json({ limit: '64kb' });

/**
 * The read errors the client words itself. Every answer here carries the
 * `kind`, so the viewer draws its own copy for each failure instead of
 * parsing prose.
 */
const viewError = (res, status, kind, error) => res.status(status).json({ kind, error });

const publicView = (state) => {
  const { instance } = state ?? {};
  if (!instance) return { configured: false };
  return {
    configured: true,
    origin: instance.origin,
    hasToken: Boolean(instance.token),
    verifySsl: instance.verifySsl,
  };
};

/**
 * The instance's own avatar and icon paths — the only image paths whose
 * bytes the proxy will fetch. Everything else is a request for a
 * stranger's path and answers a bad request before any fetch.
 */
const IMAGE_PATH_PREFIXES = ['/secure/useravatar', '/secure/viewavatar', '/images/'];

const proxyPathAllowed = (imagePath) => {
  if (!imagePath.startsWith('/') || imagePath.includes('//')) return false;
  return IMAGE_PATH_PREFIXES.some((prefix) => imagePath.startsWith(prefix));
};

// The avatar path is parsed at this boundary before any walk into a URL:
// anything the express parser hands back that is not one non-empty string
// is a bad request, not a fetch.
const imagePathSchema = z.string().trim().min(1);

export const registerJiraRoutes = (app, dependencies) => {
  const { jiraConfigStore, createRequest, createAvatarRequest } = dependencies;
  if (!jiraConfigStore) throw new Error('jira routes need a config store');

  app.get('/api/openchamber/jira', async (_req, res) => {
    try {
      return res.json(publicView(await jiraConfigStore.read()));
    } catch (error) {
      console.error('[jira] config read failed:', error?.message ?? error);
      return res.status(500).json({ error: 'Failed to read the Jira connection' });
    }
  });

  /**
   * One object can carry any mix: `origin`, `token` (absent keeps the
   * stored one, '' clears), `verifySsl`. `disconnect: true` drops the
   * connection and ignores the rest.
   */
  app.put('/api/openchamber/jira', jsonBody, async (req, res) => {
    try {
      await jiraConfigStore.save(req.body ?? {});
      const state = await jiraConfigStore.read();
      const { instance } = state;
      let connectionCheck = null;
      if (instance?.origin && instance?.token) {
        try {
          const request = (createRequest ?? createJiraRequest)();
          await request({
            config: { origin: instance.origin, token: instance.token, verifySsl: instance.verifySsl },
            path: '/rest/api/2/myself',
          });
          connectionCheck = 'ok';
        } catch (error) {
          connectionCheck = error?.kind ?? 'unreachable';
        }
      }
      return res.json({ ...publicView(state), connectionCheck });
    } catch (error) {
      const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
      if (status >= 500) console.error('[jira] config save failed:', error?.message ?? error);
      return res.status(status).json({ error: error?.message ?? 'Failed to save the Jira connection' });
    }
  });

  app.delete('/api/openchamber/jira', async (_req, res) => {
    try {
      await jiraConfigStore.clear();
      return res.json({ configured: false });
    } catch (error) {
      console.error('[jira] disconnect failed:', error?.message ?? error);
      return res.status(500).json({ error: 'Failed to disconnect Jira' });
    }
  });

  /**
   * One issue search: the quick finder's GET. `q` is sanitized at the
   * search boundary — JQL's metacharacters never reach the instance —
   * and `limit` is clamped server-side (1..25).
   */
  app.get('/api/openchamber/jira/issues/search', async (req, res) => {
    const rawQuery = Array.isArray(req.query.q) ? req.query.q[0] : req.query.q;
    const rawLimit = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;
    const parsedLimit = Number.parseInt(String(rawLimit ?? ''), 10);
    const limit = Number.isInteger(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 25) : 10;
    try {
      const state = await jiraConfigStore.read();
      const instance = state?.instance;
      if (!instance?.origin || !instance?.token) {
        return viewError(res, 409, 'unconfigured', 'No Jira connection is configured.');
      }
      const request = (createRequest ?? createJiraRequest)();
      const list = await readJiraIssueSearch({
        request,
        config: { origin: instance.origin, token: instance.token, verifySsl: instance.verifySsl },
        query: rawQuery,
        limit,
      });
      return res.json(list);
    } catch (error) {
      if (error instanceof JiraError) {
        if (error.kind === 'unauthorized') return viewError(res, 502, 'unauthorized', 'The personal access token was rejected.');
        if (error.kind === 'not-found' || error.kind === 'unreachable' || error.kind === 'server-error') {
          return viewError(res, 502, 'unreachable', 'Jira did not answer.');
        }
      }
      console.error('[jira] issue search failed:', error?.message ?? error);
      return res.status(500).json({ error: 'Failed to search Jira issues.' });
    }
  });

  /**
   * One issue, read whole: the viewer's GET. The `ref` names the issue —
   * a full browse URL or a bare key; the connection names the instance,
   * so a full URL of anywhere else is an explicit wrong-instance answer,
   * not a read against a machine the user never connected. The token
   * stays server-side: the answer carries the view, never the connection.
   */
  app.get('/api/openchamber/jira/issues/view', async (req, res) => {
    // The parser is total: a missing, empty or malformed `ref` — including
    // the express query parser's array form — reads back null, not a throw.
    const rawRef = Array.isArray(req.query.ref) ? req.query.ref[0] : req.query.ref;
    const ref = parseJiraIssueRef(rawRef);
    if (!ref) return viewError(res, 400, 'bad-ref', 'The reference is not a Jira issue.');
    try {
      const state = await jiraConfigStore.read();
      const instance = state?.instance;
      if (!instance?.origin || !instance?.token) {
        return viewError(res, 409, 'unconfigured', 'No Jira connection is configured.');
      }
      // The configured connection is always an instance root (the origin
      // form rejects paths), so an issue parsed with a context path is an
      // issue of another deployment behind the same host.
      if (ref.origin !== null && (ref.origin !== instance.origin || ref.context !== '')) {
        return viewError(res, 409, 'wrong-instance', 'The issue belongs to another Jira instance.');
      }
      const request = (createRequest ?? createJiraRequest)();
      const view = await readJiraIssueView({
        request,
        config: { origin: instance.origin, token: instance.token, verifySsl: instance.verifySsl },
        ref,
      });
      return res.json(view);
    } catch (error) {
      if (error instanceof JiraError) {
        if (error.kind === 'not-found') return viewError(res, 404, 'not-found', 'The issue was not found.');
        if (error.kind === 'unauthorized') return viewError(res, 502, 'unauthorized', 'The personal access token was rejected.');
        if (error.kind === 'unreachable' || error.kind === 'server-error') {
          return viewError(res, 502, 'unreachable', 'Jira did not answer.');
        }
      }
      console.error('[jira] issue view failed:', error?.message ?? error);
      return res.status(500).json({ error: 'Failed to read the issue.' });
    }
  });

  /**
   * The instance's own avatar and icon bytes, proxied with the token the
   * browser never has. The path's allowlist is pinned before it ever
   * reaches a URL: user avatars, view-avatars and Jira's own images are
   * the only things this route serves, and a path of anywhere else is a
   * request for a stranger's path and reads back as a bad request. Still
   * a read — one GET against the configured instance, nothing else.
   */
  app.get('/api/openchamber/jira/avatar', async (req, res) => {
    const rawPath = Array.isArray(req.query.path) ? req.query.path[0] : req.query.path;
    const parsedPath = imagePathSchema.safeParse(rawPath);
    if (!parsedPath.success) {
      return res.status(400).json({ error: 'The image request names no allowed path.' });
    }
    const imagePath = parsedPath.data;
    if (!proxyPathAllowed(imagePath)) {
      return res.status(400).json({ error: 'The image request names no allowed path.' });
    }
    try {
      const state = await jiraConfigStore.read();
      const instance = state?.instance;
      if (!instance?.origin || !instance?.token) {
        return res.status(409).json({ error: 'No Jira connection is configured.' });
      }
      const request = (createAvatarRequest ?? createJiraAvatarRequest)();
      const { contentType, bytes } = await request({
        config: { origin: instance.origin, token: instance.token, verifySsl: instance.verifySsl },
        path: imagePath,
      });
      res.set('content-type', contentType);
      res.set('cache-control', 'private, max-age=86400');
      return res.send(bytes);
    } catch (error) {
      if (error instanceof JiraError) {
        // An image the instance never served answers 404: the drawing side
        // falls back to its initials the same way, whichever the reason.
        if (error.kind === 'not-found') return res.status(404).end();
        if (error.kind === 'unauthorized') return res.status(502).end();
        if (error.kind === 'unreachable' || error.kind === 'server-error') return res.status(502).end();
      }
      console.error('[jira] avatar read failed:', error?.message ?? error);
      return res.status(500).end();
    }
  });
};
