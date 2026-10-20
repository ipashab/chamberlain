/**
 * Backlog routes for the client. The composer's backlog panel reads and
 * writes its session's staged items here, and the drain button starts here;
 * `openchamber:session-backlog` events tell every client that showed the
 * session to refetch, so an item staged in one window is honest in another.
 *
 * The routes expose the one capability the chat already owns — sending the
 * user's own messages to the user's own session, on the user's own say-so —
 * so they gate nothing behind permissions and add no capability the agent
 * tool does not have.
 */

import express from 'express';

import { asNonEmptyString } from '../shared/guards.js';

// This server parses JSON per route, not globally; every POST here that
// reads req.body needs the parser attached to the route itself.
const jsonBody = express.json({ limit: '256kb' });

export const registerBacklogRoutes = (app, dependencies) => {
  const { backlogService } = dependencies;
  if (!backlogService) throw new Error('backlog routes need a backlog service');

  const runThroughService = async (res, action, input) => {
    try {
      return res.json(await backlogService.executeAction(action, input));
    } catch (error) {
      const statusCode = Number(error?.statusCode) || 500;
      if (statusCode >= 500) console.error(`[backlog] ${action} failed:`, error?.message ?? error);
      return res.status(statusCode).json({ error: error instanceof Error ? error.message : String(error) });
    }
  };

  app.get('/api/openchamber/backlog', async (req, res) => {
    const sessionId = asNonEmptyString(req.query?.sessionID);
    if (!sessionId) return res.status(400).json({ error: 'sessionID is required' });
    return runThroughService(res, 'backlog.list', { sessionID: sessionId });
  });

  app.post('/api/openchamber/backlog', jsonBody, async (req, res) => {
    const body = req.body ?? {};
    const sessionId = asNonEmptyString(body.sessionID);
    if (!sessionId) return res.status(400).json({ error: 'sessionID is required' });
    return runThroughService(res, 'backlog.add', { sessionID: sessionId, text: body.text });
  });

  app.post('/api/openchamber/backlog/remove', jsonBody, async (req, res) => {
    const body = req.body ?? {};
    const sessionId = asNonEmptyString(body.sessionID);
    if (!sessionId) return res.status(400).json({ error: 'sessionID is required' });
    return runThroughService(res, 'backlog.remove', { sessionID: sessionId, itemID: body.itemID });
  });

  app.post('/api/openchamber/backlog/clear', jsonBody, async (req, res) => {
    const body = req.body ?? {};
    const sessionId = asNonEmptyString(body.sessionID);
    if (!sessionId) return res.status(400).json({ error: 'sessionID is required' });
    return runThroughService(res, 'backlog.clear', { sessionID: sessionId });
  });

  app.post('/api/openchamber/backlog/run', jsonBody, async (req, res) => {
    const body = req.body ?? {};
    const sessionId = asNonEmptyString(body.sessionID);
    if (!sessionId) return res.status(400).json({ error: 'sessionID is required' });
    return runThroughService(res, 'backlog.run', { sessionID: sessionId });
  });
};
