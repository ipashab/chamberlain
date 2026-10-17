// The group-preset routes of the server, `/api/openchamber/session-group-presets`,
// as the sidebar calls them. A preset binds a session folder to an agent:
// sessions created inside the folder start on that agent, and a live session
// dropped into the folder is offered a switch to it (the `applyRule` decides
// how eagerly). The contract is
// `packages/web/server/lib/session-group-presets/DOCUMENTATION.md`.

import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';

const GROUP_PRESETS_ROUTE = '/api/openchamber/session-group-presets';

export const GROUP_APPLY_RULES = ['ask', 'always', 'never'] as const;

export type GroupApplyRule = (typeof GROUP_APPLY_RULES)[number];

export const DEFAULT_GROUP_APPLY_RULE: GroupApplyRule = 'ask';

const groupPresetSchema = z.object({
  folderId: z.string().min(1),
  defaultAgent: z.string().min(1).max(128).nullable(),
  applyRule: z.enum(GROUP_APPLY_RULES),
  updatedAt: z.number().optional(),
});

export type GroupPreset = z.infer<typeof groupPresetSchema>;

const snapshotSchema = z.object({
  version: z.literal(1),
  presets: z.record(z.string().min(1), groupPresetSchema),
  // Folder ids this write deletes; the server-side merge would resurrect
  // deletions otherwise. Absent on the GET the store hydrates from.
  removed: z.array(z.string().min(1)).optional(),
  updatedAt: z.number().optional(),
});

export type GroupPresetSnapshot = z.infer<typeof snapshotSchema>;

class GroupPresetsRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GroupPresetsRequestError';
  }
}

// The route answers failures as `{ error }`; anything else falls back to the
// caller's own wording instead of guessing at the payload.
const readError = async (response: Response, fallback: string): Promise<string> => {
  const parsed = z.object({ error: z.string() }).safeParse(await response.json().catch(() => null));
  return parsed.success ? parsed.data.error : fallback;
};

export async function fetchGroupPresetSnapshot(): Promise<GroupPresetSnapshot> {
  const response = await runtimeFetch(GROUP_PRESETS_ROUTE);
  if (!response.ok) {
    throw new GroupPresetsRequestError(await readError(response, 'Failed to read group presets'));
  }
  const parsed = snapshotSchema.safeParse(await response.json());
  if (!parsed.success) {
    // The server stores what it validated; a shape it did not produce is a
    // broken contract, surfaced instead of read as "no presets".
    throw new GroupPresetsRequestError('Group presets store returned an unknown shape');
  }
  return parsed.data;
}

export async function saveGroupPresetSnapshot(snapshot: GroupPresetSnapshot): Promise<void> {
  const response = await runtimeFetch(GROUP_PRESETS_ROUTE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(snapshot),
  });
  if (!response.ok) {
    throw new GroupPresetsRequestError(await readError(response, 'Failed to save group presets'));
  }
}

/** A preset with the server's defaults applied, so callers see one shape. */
export const normalizeGroupPreset = (preset: Partial<GroupPreset> & { folderId: string }): GroupPreset => ({
  folderId: preset.folderId,
  defaultAgent: preset.defaultAgent ?? null,
  applyRule: preset.applyRule ?? DEFAULT_GROUP_APPLY_RULE,
});
