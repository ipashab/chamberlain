/**
 * Bitbucket routes for the client — the settings card's backend and the
 * read-only pull view's.
 *
 * The card reads, writes and drops one Data Center connection: an instance
 * origin, a personal access token and the instance's TLS policy. The token
 * never travels back: `readPublic` answers the fact of it, and every
 * answer here carries `{ configured, origin?, hasToken?, verifySsl? }` so
 * the card can draw itself from one shape.
 *
 * A save that carries a full connection follows with a connection check —
 * one lightweight GET the token must survive — so the card can say "the
 * token was rejected" at the moment the user pastes it, not when a board
 * shows unknown chips later. A save with no token (an origin edit or the
 * TLS switch) skips the check: there is nothing to authenticate yet.
 *
 * The pull view is the PR viewer's backend: one GET that answers the
 * pull's full read — meta, reviewers, checks, commits, files with their
 * locally rebuilt diff text, and comments. Reading is all it ever does;
 * the same verbs the chip's status reader already uses, and the pull must
 * belong to the configured instance — coordinates from another instance
 * resolve to an explicit wrong-instance answer, never a silent read of a
 * stranger's pull.
 *
 * The open pulls list is the pull surface's landing page: the token's own
 * dashboard, filtered to what is still open, capped at the limit the panel
 * asks for. The instance the user connected is the only one ever asked.
 */

import express from 'express';

import { BitbucketError, createBitbucketAvatarRequest, createBitbucketRequest } from './client.js';
import { readDashboardPulls } from './pull-list.js';
import { readPullView } from './pull-view.js';
import { parseBitbucketPullUrl } from './url.js';

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

export const registerBitbucketRoutes = (app, dependencies) => {
  const { bitbucketConfigStore, createRequest, createAvatarRequest } = dependencies;
  if (!bitbucketConfigStore) throw new Error('bitbucket routes need a config store');

  app.get('/api/openchamber/bitbucket', async (_req, res) => {
    try {
      return res.json(publicView(await bitbucketConfigStore.read()));
    } catch (error) {
      console.error('[bitbucket] config read failed:', error?.message ?? error);
      return res.status(500).json({ error: 'Failed to read the Bitbucket connection' });
    }
  });

  /**
   * One object can carry any mix: `origin`, `token` (absent keeps the
   * stored one, '' clears), `verifySsl`. `disconnect: true` drops the
   * connection and ignores the rest.
   */
  app.put('/api/openchamber/bitbucket', jsonBody, async (req, res) => {
    try {
      await bitbucketConfigStore.save(req.body ?? {});
      const state = await bitbucketConfigStore.read();
      const { instance } = state;
      let connectionCheck = null;
      if (instance?.origin && instance?.token) {
        try {
          const request = (createRequest ?? createBitbucketRequest)();
          await request({
            config: { origin: instance.origin, token: instance.token, verifySsl: instance.verifySsl },
            path: '/rest/api/1.0/projects?limit=1',
          });
          connectionCheck = 'ok';
        } catch (error) {
          connectionCheck = error?.kind ?? 'unreachable';
        }
      }
      return res.json({ ...publicView(state), connectionCheck });
    } catch (error) {
      const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
      if (status >= 500) console.error('[bitbucket] config save failed:', error?.message ?? error);
      return res.status(status).json({ error: error?.message ?? 'Failed to save the Bitbucket connection' });
    }
  });

  app.delete('/api/openchamber/bitbucket', async (_req, res) => {
    try {
      await bitbucketConfigStore.clear();
      return res.json({ configured: false });
    } catch (error) {
      console.error('[bitbucket] disconnect failed:', error?.message ?? error);
      return res.status(500).json({ error: 'Failed to disconnect Bitbucket' });
    }
  });

  /**
   * The token's own pulls — the preloaded list the panel lands on: the
   * open ones capped at `limit`, closed ones riding along so the panel can
   * filter by state. `limit` is clamped server-side (1..25); the shape of
   * a query string the express parser may hand back as an array reads back
   * as the default, not a throw. The answer carries `truncated`, the
   * honest admission the dashboard held more open pulls than the cap let
   * the walk collect.
   */
  app.get('/api/openchamber/bitbucket/pulls', async (req, res) => {
    const rawLimit = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;
    const parsedLimit = Number.parseInt(String(rawLimit ?? ''), 10);
    const limit = Number.isInteger(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 25) : 10;
    try {
      const state = await bitbucketConfigStore.read();
      const instance = state?.instance;
      if (!instance?.origin || !instance?.token) {
        return viewError(res, 409, 'unconfigured', 'No Bitbucket connection is configured.');
      }
      const request = (createRequest ?? createBitbucketRequest)();
      const list = await readDashboardPulls({
        request,
        config: { origin: instance.origin, token: instance.token, verifySsl: instance.verifySsl },
        limit,
      });
      return res.json(list);
    } catch (error) {
      if (error instanceof BitbucketError) {
        if (error.kind === 'unauthorized') return viewError(res, 502, 'unauthorized', 'The access token was rejected.');
        if (error.kind === 'not-found' || error.kind === 'unreachable' || error.kind === 'server-error') {
          return viewError(res, 502, 'unreachable', 'Bitbucket did not answer.');
        }
      }
      console.error('[bitbucket] open pulls failed:', error?.message ?? error);
      return res.status(500).json({ error: 'Failed to read open pull requests.' });
    }
  });

  /**
   * One pull request, read whole: the viewer's GET. The link names the
   * pull; the connection names the instance — a pull from anywhere else is
   * an explicit wrong-instance answer, not a read against a machine the
   * user never connected. The token stays server-side: the answer carries
   * the view, never the connection.
   */
  app.get('/api/openchamber/bitbucket/pulls/view', async (req, res) => {
    // The parser is total: a missing, empty or malformed `url` — including
    // the express query parser's array form — reads back null, not a throw.
    const ref = parseBitbucketPullUrl(req.query.url);
    if (!ref) return viewError(res, 400, 'bad-url', 'The link is not a Bitbucket pull request.');
    try {
      const state = await bitbucketConfigStore.read();
      const instance = state?.instance;
      if (!instance?.origin || !instance?.token) {
        return viewError(res, 409, 'unconfigured', 'No Bitbucket connection is configured.');
      }
      // The configured connection is always an instance root (the origin
      // form rejects paths), so a pull parsed with a context path is a
      // pull of another deployment behind the same host.
      if (ref.origin !== instance.origin || ref.context !== '') {
        return viewError(res, 409, 'wrong-instance', 'The pull request belongs to another Bitbucket instance.');
      }
      const request = (createRequest ?? createBitbucketRequest)();
      const view = await readPullView({
        request,
        config: { origin: instance.origin, token: instance.token, verifySsl: instance.verifySsl },
        ref,
      });
      return res.json(view);
    } catch (error) {
      if (error instanceof BitbucketError) {
        if (error.kind === 'not-found') return viewError(res, 404, 'not-found', 'The pull request was not found.');
        if (error.kind === 'unauthorized') return viewError(res, 502, 'unauthorized', 'The access token was rejected.');
        if (error.kind === 'unreachable' || error.kind === 'server-error') {
          return viewError(res, 502, 'unreachable', 'Bitbucket did not answer.');
        }
      }
      console.error('[bitbucket] pull view failed:', error?.message ?? error);
      return res.status(500).json({ error: 'Failed to read the pull request.' });
    }
  });

  /**
   * One user's avatar bytes, proxied with the token the browser never has.
   * The slug's charset is pinned before it ever reaches a URL: DC slugs
   * are account names, so anything outside them is a request for a
   * stranger's path and reads back as a bad request. Still a read — one
   * GET per image against the configured instance, nothing else.
   */
  app.get('/api/openchamber/bitbucket/pulls/avatar', async (req, res) => {
    const rawSlug = Array.isArray(req.query.slug) ? req.query.slug[0] : req.query.slug;
    const slug = typeof rawSlug === 'string' ? rawSlug.trim() : '';
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(slug)) {
      return res.status(400).json({ error: 'The avatar request names no user.' });
    }
    const rawSize = Array.isArray(req.query.size) ? req.query.size[0] : req.query.size;
    const size = rawSize === '32' || rawSize === '64' ? rawSize : '48';
    try {
      const state = await bitbucketConfigStore.read();
      const instance = state?.instance;
      if (!instance?.origin || !instance?.token) {
        return res.status(409).json({ error: 'No Bitbucket connection is configured.' });
      }
      const request = (createAvatarRequest ?? createBitbucketAvatarRequest)();
      const { contentType, bytes } = await request({
        config: { origin: instance.origin, token: instance.token, verifySsl: instance.verifySsl },
        path: `/users/${slug}/avatar.png`,
        search: `?s=${size}`,
      });
      res.set('content-type', contentType);
      res.set('cache-control', 'private, max-age=86400');
      return res.send(bytes);
    } catch (error) {
      if (error instanceof BitbucketError) {
        // A user the instance never heard of answers 404: the drawing side
        // falls back to its initials the same way, whichever the reason.
        if (error.kind === 'not-found') return res.status(404).end();
        if (error.kind === 'unauthorized') return res.status(502).end();
        if (error.kind === 'unreachable' || error.kind === 'server-error') return res.status(502).end();
      }
      console.error('[bitbucket] avatar read failed:', error?.message ?? error);
      return res.status(500).end();
    }
  });
};
