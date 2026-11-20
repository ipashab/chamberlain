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

import type { Application, Request, Response } from '../shared/http-contracts.js';
import { asNonEmptyString, isRecord } from '../shared/guards.js';
import type { BacklogService } from './service.js';

// This server parses JSON per route, not globally; every POST here that
// reads req.body needs the parser attached to the route itself.
const jsonBody = express.json({ limit: '256kb' });

/** Для сообщения об ошибке: message упавшего, иначе сам упавший. */
const describeFailure = (error: unknown): unknown =>
  error !== null && typeof error === 'object' && 'message' in error ? error.message ?? error : error;

export const registerBacklogRoutes = (
  app: Application,
  dependencies: { backlogService: BacklogService },
) => {
  const { backlogService } = dependencies;
  if (!backlogService) throw new Error('backlog routes need a backlog service');

  const runThroughService = async (res: Response, action: string, input: unknown) => {
    try {
      return res.json(await backlogService.executeAction(action, input));
    } catch (error) {
      const statusCode = Number(
        error !== null && typeof error === 'object' && 'statusCode' in error ? error.statusCode : undefined,
      ) || 500;
      if (statusCode >= 500) console.error(`[backlog] ${action} failed:`, describeFailure(error));
      return res.status(statusCode).json({ error: error instanceof Error ? error.message : String(error) });
    }
  };

  app.get('/api/openchamber/backlog', async (req: Request, res: Response) => {
    const sessionId = asNonEmptyString(req.query?.sessionID);
    if (!sessionId) return res.status(400).json({ error: 'sessionID is required' });
    return runThroughService(res, 'backlog.list', { sessionID: sessionId });
  });

  app.post('/api/openchamber/backlog', jsonBody, async (req: Request, res: Response) => {
    const body = isRecord(req.body) ? req.body : {};
    const sessionId = asNonEmptyString(body.sessionID);
    if (!sessionId) return res.status(400).json({ error: 'sessionID is required' });
    return runThroughService(res, 'backlog.add', { sessionID: sessionId, text: body.text });
  });

  app.post('/api/openchamber/backlog/remove', jsonBody, async (req: Request, res: Response) => {
    const body = isRecord(req.body) ? req.body : {};
    const sessionId = asNonEmptyString(body.sessionID);
    if (!sessionId) return res.status(400).json({ error: 'sessionID is required' });
    return runThroughService(res, 'backlog.remove', { sessionID: sessionId, itemID: body.itemID });
  });

  app.post('/api/openchamber/backlog/move', jsonBody, async (req: Request, res: Response) => {
    const body = isRecord(req.body) ? req.body : {};
    const sessionId = asNonEmptyString(body.sessionID);
    if (!sessionId) return res.status(400).json({ error: 'sessionID is required' });
    return runThroughService(res, 'backlog.move', { sessionID: sessionId, itemID: body.itemID, position: body.position });
  });

  app.post('/api/openchamber/backlog/clear', jsonBody, async (req: Request, res: Response) => {
    const body = isRecord(req.body) ? req.body : {};
    const sessionId = asNonEmptyString(body.sessionID);
    if (!sessionId) return res.status(400).json({ error: 'sessionID is required' });
    return runThroughService(res, 'backlog.clear', { sessionID: sessionId });
  });

  app.post('/api/openchamber/backlog/run', jsonBody, async (req: Request, res: Response) => {
    const body = isRecord(req.body) ? req.body : {};
    const sessionId = asNonEmptyString(body.sessionID);
    if (!sessionId) return res.status(400).json({ error: 'sessionID is required' });
    return runThroughService(res, 'backlog.run', { sessionID: sessionId });
  });
};
