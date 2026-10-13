/**
 * Confluence routes for the client — the settings card's backend and the
 * read-only page reader's.
 *
 * The card reads, writes and drops one Data Center connection: an instance
 * origin, a personal access token and the instance's TLS policy — the same
 * shape the Jira card uses, because it is the same kind of machine. The
 * token never travels back: `readPublic` answers the fact of it, and
 * every answer here carries `{ configured, origin?, hasToken?, verifySsl? }`
 * so the card can draw itself from one shape.
 *
 * A save that carries a full connection follows with a connection check —
 * one lightweight GET the token must survive (`/rest/api/user/current`) —
 * so the card can say "the token was rejected" at the moment the user
 * pastes it, not when a reader shows its first failure later. A save with
 * no token (an origin edit or the TLS switch) skips the check.
 *
 * The page view is the reader's backend: one GET that answers the page's
 * rendered body, space and version. Reading is all it ever does; the id
 * is the page's own numeric id, and `readPublic` still never hands the
 * token to the browser.
 */

import express from 'express';

import { ConfluenceError, createConfluenceRequest } from './client.js';
import { readConfluencePage } from './page.js';
import { readConfluenceSearch } from './search.js';

// This server parses JSON per route, not globally; the body parser is
// attached to the route that reads req.body.
const jsonBody = express.json({ limit: '64kb' });

/**
 * The read errors the client words itself. Every answer here carries the
 * `kind`, so the reader draws its own copy for each failure instead of
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

export const registerConfluenceRoutes = (app, dependencies) => {
  const { confluenceConfigStore, createRequest } = dependencies;
  if (!confluenceConfigStore) throw new Error('confluence routes need a config store');

  app.get('/api/openchamber/confluence', async (_req, res) => {
    try {
      return res.json(publicView(await confluenceConfigStore.read()));
    } catch (error) {
      console.error('[confluence] config read failed:', error?.message ?? error);
      return res.status(500).json({ error: 'Failed to read the Confluence connection' });
    }
  });

  /**
   * One object can carry any mix: `origin`, `token` (absent keeps the
   * stored one, '' clears), `verifySsl`. `disconnect: true` drops the
   * connection and ignores the rest.
   */
  app.put('/api/openchamber/confluence', jsonBody, async (req, res) => {
    try {
      await confluenceConfigStore.save(req.body ?? {});
      const state = await confluenceConfigStore.read();
      const { instance } = state;
      let connectionCheck = null;
      if (instance?.origin && instance?.token) {
        try {
          const request = (createRequest ?? createConfluenceRequest)();
          await request({
            config: { origin: instance.origin, token: instance.token, verifySsl: instance.verifySsl },
            path: '/rest/api/user/current',
          });
          connectionCheck = 'ok';
        } catch (error) {
          connectionCheck = error?.kind ?? 'unreachable';
        }
      }
      return res.json({ ...publicView(state), connectionCheck });
    } catch (error) {
      const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
      if (status >= 500) console.error('[confluence] config save failed:', error?.message ?? error);
      return res.status(status).json({ error: error?.message ?? 'Failed to save the Confluence connection' });
    }
  });

  app.delete('/api/openchamber/confluence', async (_req, res) => {
    try {
      await confluenceConfigStore.clear();
      return res.json({ configured: false });
    } catch (error) {
      console.error('[confluence] disconnect failed:', error?.message ?? error);
      return res.status(500).json({ error: 'Failed to disconnect Confluence' });
    }
  });

  /**
   * One page search: the reader's quick finder. `q` is sanitized at the
   * search boundary — CQL's metacharacters never reach the instance —
   * and `limit` is clamped server-side (1..25).
   */
  app.get('/api/openchamber/confluence/pages/search', async (req, res) => {
    const rawQuery = Array.isArray(req.query.q) ? req.query.q[0] : req.query.q;
    const rawLimit = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;
    const parsedLimit = Number.parseInt(String(rawLimit ?? ''), 10);
    const limit = Number.isInteger(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 25) : 10;
    try {
      const state = await confluenceConfigStore.read();
      const instance = state?.instance;
      if (!instance?.origin || !instance?.token) {
        return viewError(res, 409, 'unconfigured', 'No Confluence connection is configured.');
      }
      const request = (createRequest ?? createConfluenceRequest)();
      const list = await readConfluenceSearch({
        request,
        config: { origin: instance.origin, token: instance.token, verifySsl: instance.verifySsl },
        query: rawQuery,
        limit,
      });
      return res.json(list);
    } catch (error) {
      if (error instanceof ConfluenceError) {
        if (error.kind === 'unauthorized') return viewError(res, 502, 'unauthorized', 'The personal access token was rejected.');
        if (error.kind === 'not-found' || error.kind === 'unreachable' || error.kind === 'server-error') {
          return viewError(res, 502, 'unreachable', 'Confluence did not answer.');
        }
      }
      console.error('[confluence] page search failed:', error?.message ?? error);
      return res.status(500).json({ error: 'Failed to search Confluence pages.' });
    }
  });

  /**
   * One page, read whole: the reader's GET. The `id` is the page's own
   * numeric id — the same id the instance's URL carries after `/pages/`.
   * The token stays server-side: the answer carries the view, never the
   * connection.
   */
  app.get('/api/openchamber/confluence/pages/view', async (req, res) => {
    const rawId = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
    const id = String(rawId ?? '').trim();
    if (!/^\d+$/.test(id)) {
      return viewError(res, 400, 'bad-ref', 'The reference is not a Confluence page id.');
    }
    try {
      const state = await confluenceConfigStore.read();
      const instance = state?.instance;
      if (!instance?.origin || !instance?.token) {
        return viewError(res, 409, 'unconfigured', 'No Confluence connection is configured.');
      }
      const request = (createRequest ?? createConfluenceRequest)();
      const view = await readConfluencePage({
        request,
        config: { origin: instance.origin, token: instance.token, verifySsl: instance.verifySsl },
        pageId: id,
      });
      return res.json(view);
    } catch (error) {
      if (error instanceof ConfluenceError) {
        if (error.kind === 'unauthorized') return viewError(res, 502, 'unauthorized', 'The personal access token was rejected.');
        if (error.kind === 'not-found') return viewError(res, 404, 'not-found', 'The page was not found.');
        if (error.kind === 'unreachable' || error.kind === 'server-error') {
          return viewError(res, 502, 'unreachable', 'Confluence did not answer.');
        }
      }
      console.error('[confluence] page view failed:', error?.message ?? error);
      return res.status(500).json({ error: 'Failed to read the Confluence page.' });
    }
  });
};
