/**
 * The engines' HTTP surface: purely additive, no existing route changes.
 *
 *   GET /api/openchamber/engines        → which engines exist, which is active, parse warnings
 *   GET /api/openchamber/engines/active → the active engine's descriptor plus one real probe (ok/version/latency)
 *
 * Mounted under /api/*, these inherit the existing UI auth (401 when not
 * logged in) — do not move them to an unauthenticated namespace for
 * convenience.
 */

import type { Application, Request } from '../shared/http-contracts.js';
import { hasProperties } from '../shared/guards.js';

export interface EngineRoutesDependencies {
  getSnapshot: (options?: { force?: boolean }) => Promise<object>;
  probeActive: (options?: { force?: boolean }) => Promise<object>;
}

export const registerEngineRoutes = (app: Application, { getSnapshot, probeActive }: EngineRoutesDependencies) => {
  app.get('/api/openchamber/engines', async (req: Request, res) => {
    try {
      const force = req?.query?.refresh === '1';
      const snapshot = await getSnapshot({ force });
      res.json(snapshot);
    } catch (error) {
      const detail = hasProperties(error) ? error.message : undefined;
      res.status(500).json({ error: detail ?? 'Failed to load engine registry' });
    }
  });

  app.get('/api/openchamber/engines/active', async (req: Request, res) => {
    try {
      const force = req?.query?.refresh === '1';
      const result = await probeActive({ force });
      res.json(result);
    } catch (error) {
      const detail = hasProperties(error) ? error.message : undefined;
      res.status(500).json({ error: detail ?? 'Failed to probe the active engine' });
    }
  });
};
