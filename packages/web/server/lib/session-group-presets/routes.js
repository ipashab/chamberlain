import express from 'express';
import { z } from 'zod';

// Group presets bind a session folder to an agent: sessions created inside the
// folder start with that agent, and a live session dropped into the folder is
// offered a one-time switch to it. The upstream `SessionFolder` entity itself
// stays untouched — this table is keyed by folder id and lives beside it.

const MAX_BODY_BYTES = 1024 * 1024;

// This server parses JSON per route, not globally; the POST that reads
// req.body needs the parser attached to the route itself.
const jsonBody = express.json({ limit: '1mb' });

// 'ask' is the settled default: dropping a live session into a folder suggests
// the folder's agent once, and a manual agent pick in the chat wins afterwards.
const applyRuleSchema = z.enum(['ask', 'always', 'never']);

const presetSchema = z.object({
  folderId: z.string().min(1),
  defaultAgent: z.string().min(1).max(128).nullable(),
  applyRule: applyRuleSchema,
  updatedAt: z.number().optional(),
}).strict();

const snapshotSchema = z.object({
  version: z.literal(1),
  presets: z.record(z.string().min(1), presetSchema),
  // Folder ids this write deletes; the merge below would resurrect them
  // otherwise, exactly the way session folders carry a deletions inbox.
  removed: z.array(z.string().min(1)).optional(),
  // The save writes `updatedAt` at the top; here it is provenance, not payload.
  updatedAt: z.number().optional(),
}).strict().superRefine((snapshot, ctx) => {
  for (const [folderId, preset] of Object.entries(snapshot.presets)) {
    // The map key and the preset's own id name the same folder; a payload
    // that disagrees is rejected instead of silently re-keyed.
    if (preset.folderId !== folderId) {
      ctx.addIssue({ code: 'custom', message: `Preset for "${folderId}" names a different folder` });
    }
  }
});

export const registerSessionGroupPresetsRoutes = (app, dependencies) => {
  const {
    fsPromises,
    path,
    openchamberDataDir,
  } = dependencies;

  const filePath = path.join(openchamberDataDir, 'session-group-presets.json');
  let saveQueue = Promise.resolve();

  // Strict on read: malformed state answers 500 instead of masquerading as an
  // empty table. A valid incoming write repairs it (see save).
  const readSnapshot = async () => {
    const raw = await fsPromises.readFile(filePath, 'utf8').catch((error) => {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    });
    if (!raw) return { presets: {} };
    let parsedJson;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      return { error: 'Stored session group presets are malformed' };
    }
    const parsed = snapshotSchema.safeParse(parsedJson);
    if (!parsed.success) {
      return { error: 'Stored session group presets have an invalid shape' };
    }
    return { presets: parsed.data.presets };
  };

  app.get('/api/openchamber/session-group-presets', async (_req, res) => {
    try {
      const snapshot = await readSnapshot();
      if (snapshot.error) {
        return res.status(500).json({ error: snapshot.error });
      }
      return res.json({ version: 1, presets: snapshot.presets });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to read session group presets';
      return res.status(500).json({ error: message });
    }
  });

  app.post('/api/openchamber/session-group-presets', jsonBody, async (req, res) => {
    const parsed = snapshotSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid session group presets payload' });
    }
    if (JSON.stringify(parsed.data).length > MAX_BODY_BYTES) {
      return res.status(413).json({ error: 'Payload too large' });
    }
    const body = parsed.data;

    const save = async () => {
      let tmp;
      let saved = false;
      try {
        const current = await readSnapshot();
        // Per folder id the incoming write wins; folders the writer never saw
        // stay, because a client may be hydrating from an empty bootstrap and
        // must not delete presets it has never read. Names in `removed` are
        // the one sanctioned way to delete.
        const currentPresets = current.error ? {} : current.presets;
        const merged = { ...currentPresets, ...body.presets };
        for (const folderId of body.removed ?? []) {
          delete merged[folderId];
        }
        const outgoing = {
          version: 1,
          presets: merged,
          updatedAt: Date.now(),
        };
        await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
        tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        await fsPromises.writeFile(tmp, JSON.stringify(outgoing, null, 2), 'utf8');
        await fsPromises.rename(tmp, filePath);
        saved = true;
        return res.json({ success: true });
      } catch (error) {
        if (tmp && !saved) {
          await fsPromises.unlink(tmp).catch(() => {});
        }
        const message = error instanceof Error ? error.message : 'Failed to write session group presets';
        return res.status(500).json({ error: message });
      }
    };

    const pendingSave = saveQueue.then(save, save);
    saveQueue = pendingSave.then(() => undefined, () => undefined);
    return pendingSave;
  });
};
