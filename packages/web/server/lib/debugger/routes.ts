/**
 * Debugger routes for the client. One REST surface behind the debug panel:
 * launch input in, the full state projection out on every action, plus
 * `openchamber:debugger-changed` events that tell the panel to refetch.
 *
 * Running Python on the user's machine is the same trust level as the
 * terminal's shell runs; these routes add no other capability and gate
 * nothing behind permissions.
 */

import express from 'express';

import type { createDebuggerService } from './service.js';
import type { Application, Request, Response } from '../shared/http-contracts.js';
import { isRecord } from '../shared/guards.js';

type DebuggerService = ReturnType<typeof createDebuggerService>;

export interface DebuggerRouteDependencies {
  debuggerService: DebuggerService;
}

// This server parses JSON per route, not globally; every POST here that
// reads req.body needs the parser attached to the route itself.
const jsonBody = express.json({ limit: '1mb' });

const isRouteFailure = (value: unknown): value is { statusCode?: unknown; message?: unknown } =>
  isRecord(value);

const errorStatusCode = (error: unknown): number => {
  const statusCode = isRouteFailure(error) ? error.statusCode : undefined;
  return typeof statusCode === 'number' && Number.isInteger(statusCode) ? statusCode : 500;
};

const errorMessage = (error: unknown): unknown =>
  isRecord(error) && 'message' in error ? error.message : undefined;

const respondWithState = async (
  res: Response,
  action: () => unknown,
): Promise<Response> => {
  try {
    return res.json(await action());
  } catch (error) {
    const status = errorStatusCode(error);
    if (status >= 500) console.error('[debugger] request failed:', errorMessage(error) ?? error);
    return res.status(status).json({ error: errorMessage(error) ?? 'The debugger request failed' });
  }
};

export const registerDebuggerRoutes = (app: Application, { debuggerService }: DebuggerRouteDependencies) => {
  if (!debuggerService) throw new Error('debugger routes need a debugger service');

  app.get('/api/openchamber/debugger/state', async (_req: Request, res: Response) => {
    return respondWithState(res, () => debuggerService.state());
  });

  app.post('/api/openchamber/debugger/sessions', jsonBody, async (req: Request, res: Response) => {
    return respondWithState(res, () => debuggerService.start(req.body ?? {}));
  });

  app.delete('/api/openchamber/debugger/sessions/current', async (_req: Request, res: Response) => {
    return respondWithState(res, () => debuggerService.stop());
  });

  app.post('/api/openchamber/debugger/sessions/current/breakpoints', jsonBody, async (req: Request, res: Response) => {
    return respondWithState(res, () => debuggerService.setBreakpoints(req.body ?? {}));
  });

  app.post('/api/openchamber/debugger/sessions/current/continue', async (_req: Request, res: Response) => {
    return respondWithState(res, () => debuggerService.continueRun());
  });

  app.post('/api/openchamber/debugger/sessions/current/step', jsonBody, async (req: Request, res: Response) => {
    const body = isRecord(req.body) ? req.body : {};
    return respondWithState(res, () => debuggerService.controlStep(body.kind));
  });

  app.post('/api/openchamber/debugger/sessions/current/evaluate', jsonBody, async (req: Request, res: Response) => {
    return respondWithState(res, () => debuggerService.evaluate(req.body ?? {}));
  });

  app.post('/api/openchamber/debugger/variables', jsonBody, async (req: Request, res: Response) => {
    return respondWithState(res, () => debuggerService.getVariables(req.body ?? {}));
  });
};
