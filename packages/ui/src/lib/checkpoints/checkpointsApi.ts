// The transcript's checkpoint routes, `/api/openchamber/checkpoints/*`, as
// the message rows call them. Every answer is parsed here, once, into the
// types the rows render; a shape the server did not send fails the fetch
// rather than putting half-typed state on the row. The contract is the
// Contracts section of
// `packages/web/server/lib/checkpoints/DOCUMENTATION.md`.

import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';

const CHECKPOINTS_ROUTE = '/api/openchamber/checkpoints';
const CHECKPOINTS_RESTORE_ROUTE = '/api/openchamber/checkpoints/restore';

const treeSchema = z.string().regex(/^[0-9a-f]{40,64}$/);
const refNameSchema = z.string().regex(/^refs\/openchamber\/checkpoints\//);

const restoredSchema = z.object({
  at: z.number(),
  tree: treeSchema,
  refName: refNameSchema,
});

const checkpointEntrySchema = z.object({
  /** The user message the turn answers; the row key and the restore target. */
  id: z.string(),
  userMessageID: z.string(),
  directory: z.string(),
  tree: treeSchema,
  baseRefName: refNameSchema,
  createdAt: z.number(),
  /** The files the turn touched, the restore scope. */
  files: z.array(z.string()),
  truncated: z.boolean(),
  /** The state the last restore displaced, when the checkpoint was restored. */
  restored: restoredSchema.nullable().catch(null),
});
export type CheckpointEntry = z.infer<typeof checkpointEntrySchema>;

const checkpointListSchema = z.object({
  sessionID: z.string(),
  checkpoints: z.array(checkpointEntrySchema),
});

const restoreOutcomeSchema = z.object({
  sessionID: z.string(),
  checkpointID: z.string(),
  restored: z.array(z.string()),
  removed: z.array(z.string()),
  skipped: z.array(z.object({ path: z.string(), reason: z.string() })),
});
type CheckpointRestoreOutcome = z.infer<typeof restoreOutcomeSchema>;

const errorSchema = z.object({ error: z.string() });

const errorTextFrom = async (response: Response, fallback: string) => {
  const raw = await response.json().catch(() => null);
  const parsed = errorSchema.safeParse(raw);
  return parsed.success ? parsed.data.error : fallback;
};

export const checkpointsApi = {
  /** The session's registry, newest first; a session without checkpoints answers empty. */
  list: async (sessionId: string, fetchImpl: typeof runtimeFetch = runtimeFetch): Promise<CheckpointEntry[]> => {
    const response = await fetchImpl(`${CHECKPOINTS_ROUTE}?sessionID=${encodeURIComponent(sessionId)}`, {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(await errorTextFrom(response, 'The checkpoints could not be loaded'));
    }
    const raw = await response.json().catch(() => null);
    const parsed = checkpointListSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error('Checkpoints response did not match the expected shape');
    }
    return parsed.data.checkpoints;
  },

  /**
   * Puts the turn's files back (`undo: false`) or restores what the last
   * restore displaced (`undo: true`). The server grades failures; the
   * message it sends is what the row shows.
   */
  restore: async (sessionId: string, checkpointId: string, undo: boolean, fetchImpl: typeof runtimeFetch = runtimeFetch): Promise<CheckpointRestoreOutcome> => {
    const response = await fetchImpl(CHECKPOINTS_RESTORE_ROUTE, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ sessionID: sessionId, checkpointID: checkpointId, undo }),
    });
    if (!response.ok) {
      throw new Error(await errorTextFrom(response, undo ? 'The undo failed' : 'The restore failed'));
    }
    const raw = await response.json().catch(() => null);
    const parsed = restoreOutcomeSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error('Restore response did not match the expected shape');
    }
    return parsed.data;
  },
};
