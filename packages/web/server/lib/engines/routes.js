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

export const registerEngineRoutes = (app, { getSnapshot, probeActive } = {}) => {
  app.get('/api/openchamber/engines', async (req, res) => {
    try {
      const force = req?.query?.refresh === '1';
      const snapshot = await getSnapshot({ force });
      res.json(snapshot);
    } catch (error) {
      res.status(500).json({ error: error?.message ?? 'Failed to load engine registry' });
    }
  });

  app.get('/api/openchamber/engines/active', async (req, res) => {
    try {
      const force = req?.query?.refresh === '1';
      const result = await probeActive({ force });
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error?.message ?? 'Failed to probe the active engine' });
    }
  });
};
