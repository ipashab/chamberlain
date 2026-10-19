/**
 * Checkpoint routes for the client. The transcript reads the registry per
 * session, and the restore action posts here; `openchamber:session-checkpoints`
 * events tell every client that showed the session to refetch, so a restore
 * made in one window is honest in another.
 *
 * Restore reaches into the worktree the session edits, the same trust level
 * as the file routes; the routes add no capability the chat already has and
 * gate nothing behind permissions.
 */

import express from 'express';

import { asNonEmptyString } from '../shared/guards.js';

// This server parses JSON per route, not globally; every POST here that
// reads req.body needs the parser attached to the route itself.
const jsonBody = express.json({ limit: '256kb' });

const STATUS_BY_GRADE = {
  400: 400,
  404: 404,
  409: 409,
  500: 500,
};

export const registerCheckpointRoutes = (app, dependencies) => {
  const { checkpointsRuntime } = dependencies;
  if (!checkpointsRuntime) throw new Error('checkpoint routes need a checkpoints runtime');

  app.get('/api/openchamber/checkpoints', async (req, res) => {
    const sessionId = asNonEmptyString(req.query?.sessionID);
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionID is required' });
    }
    try {
      return res.json({ sessionID: sessionId, checkpoints: await checkpointsRuntime.list(sessionId) });
    } catch (error) {
      console.error('[checkpoints] list failed:', error?.message ?? error);
      return res.status(500).json({ error: 'The checkpoint registry could not be read' });
    }
  });

  app.post('/api/openchamber/checkpoints/restore', jsonBody, async (req, res) => {
    const body = req.body ?? {};
    const sessionId = asNonEmptyString(body.sessionID);
    const checkpointId = asNonEmptyString(body.checkpointID);
    const undo = body.undo === true;
    if (!sessionId || !checkpointId) {
      return res.status(400).json({ error: 'sessionID and checkpointID are required' });
    }
    const outcome = await checkpointsRuntime.restore(sessionId, checkpointId, { undo });
    if (!outcome.ok) {
      const status = STATUS_BY_GRADE[outcome.statusCode] ?? 500;
      if (status >= 500) console.error('[checkpoints] restore failed:', outcome.message);
      return res.status(status).json({ error: outcome.message ?? 'The restore failed' });
    }
    return res.json({
      sessionID: sessionId,
      checkpointID: checkpointId,
      restored: outcome.restored,
      removed: outcome.removed,
      skipped: outcome.skipped,
    });
  });
};
