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

import { asNonEmptyString, hasProperties, isRecord } from '../shared/guards.js';
import type { Application, Request, Response } from '../shared/http-contracts.js';

// This server parses JSON per route, not globally; every POST here that
// reads req.body needs the parser attached to the route itself.
const jsonBody = express.json({ limit: '256kb' });

const STATUS_BY_GRADE: Record<number, number> = {
  400: 400,
  404: 404,
  409: 409,
  500: 500,
};

interface RestoreOutcomeOk {
  ok: true;
  checkpoint: string;
  restored: string[];
  removed: string[];
  skipped: Array<{ path: string; reason: string }>;
}

interface RestoreOutcomeFailed {
  ok: false;
  statusCode: number;
  message: string;
}

export type CheckpointRestoreOutcome = RestoreOutcomeOk | RestoreOutcomeFailed;

export interface CheckpointsRuntimeRoutes {
  list: (sessionId: string) => Promise<unknown>;
  restore: (sessionId: string, checkpointId: string, options: { undo: boolean }) => Promise<CheckpointRestoreOutcome>;
}

export interface CheckpointRoutesDependencies {
  checkpointsRuntime: CheckpointsRuntimeRoutes;
}

export const registerCheckpointRoutes = (app: Application, { checkpointsRuntime }: CheckpointRoutesDependencies) => {
  if (!checkpointsRuntime) throw new Error('checkpoint routes need a checkpoints runtime');

  app.get('/api/openchamber/checkpoints', async (req: Request, res: Response) => {
    const sessionId = asNonEmptyString(req.query?.sessionID);
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionID is required' });
    }
    try {
      return res.json({ sessionID: sessionId, checkpoints: await checkpointsRuntime.list(sessionId) });
    } catch (error) {
      const detail = hasProperties(error) ? error.message : undefined;
      console.error('[checkpoints] list failed:', detail ?? error);
      return res.status(500).json({ error: 'The checkpoint registry could not be read' });
    }
  });

  app.post('/api/openchamber/checkpoints/restore', jsonBody, async (req: Request<unknown>, res: Response) => {
    const raw: unknown = req.body ?? {};
    const body: Record<string, unknown> = isRecord(raw) ? raw : {};
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
