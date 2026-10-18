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

// This server parses JSON per route, not globally; every POST here that
// reads req.body needs the parser attached to the route itself.
const jsonBody = express.json({ limit: '1mb' });

const respondWithState = async (res, action) => {
  try {
    return res.json(await action());
  } catch (error) {
    const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
    if (status >= 500) console.error('[debugger] request failed:', error?.message ?? error);
    return res.status(status).json({ error: error?.message ?? 'The debugger request failed' });
  }
};

export const registerDebuggerRoutes = (app, dependencies) => {
  const { debuggerService } = dependencies;
  if (!debuggerService) throw new Error('debugger routes need a debugger service');

  app.get('/api/openchamber/debugger/state', async (_req, res) => {
    return respondWithState(res, () => debuggerService.state());
  });

  app.post('/api/openchamber/debugger/sessions', jsonBody, async (req, res) => {
    return respondWithState(res, () => debuggerService.start(req.body ?? {}));
  });

  app.delete('/api/openchamber/debugger/sessions/current', async (_req, res) => {
    return respondWithState(res, () => debuggerService.stop());
  });

  app.post('/api/openchamber/debugger/sessions/current/breakpoints', jsonBody, async (req, res) => {
    return respondWithState(res, () => debuggerService.setBreakpoints(req.body ?? {}));
  });

  app.post('/api/openchamber/debugger/sessions/current/continue', async (_req, res) => {
    return respondWithState(res, () => debuggerService.continueRun());
  });

  app.post('/api/openchamber/debugger/sessions/current/step', jsonBody, async (req, res) => {
    return respondWithState(res, () => debuggerService.controlStep(req.body?.kind));
  });

  app.post('/api/openchamber/debugger/sessions/current/evaluate', jsonBody, async (req, res) => {
    return respondWithState(res, () => debuggerService.evaluate(req.body ?? {}));
  });

  app.post('/api/openchamber/debugger/variables', jsonBody, async (req, res) => {
    return respondWithState(res, () => debuggerService.getVariables(req.body ?? {}));
  });
};
