import type { Session } from '@/lib/opencode/model';

/** Entries a session pick lists; recent first, and never a hidden subtask. */
const REGION_PICKER_SESSION_LIMIT = 8;

/** Sessions a Chat pick may offer, as a pure cut: recent first, subtasks (a
    subagent run is not a conversation to pick) and archived rows left out,
    the newest `limit` kept. */
export const pickRegionPickerSessions = (
    sessions: readonly Session[],
    limit = REGION_PICKER_SESSION_LIMIT,
): Session[] => {
    const own = sessions.filter((entry) => !entry.parentID && !entry.time.archived);
    own.sort((a, b) => b.time.updated - a.time.updated);
    return own.slice(0, limit);
};

/**
 * The Chat pick for one directory: the bucket keyed at the directory plus the
 * buckets under it. A managed Chats root keeps its own sessions this way —
 * they live one level down, in `chats/<date>/<sessionId>` — as does a project
 * root over its subdirectories; sessions from an unrelated directory never
 * join the pick.
 */
export const pickRegionPickerSessionsForDirectory = (
    sessionsByDirectory: ReadonlyMap<string, readonly Session[]>,
    directoryKey: string,
    limit = REGION_PICKER_SESSION_LIMIT,
): Session[] => {
    if (!directoryKey) return [];
    const scoped: Session[] = [];
    for (const [directory, sessions] of sessionsByDirectory) {
        if (directory === directoryKey || directory.startsWith(`${directoryKey}/`)) {
            scoped.push(...sessions);
        }
    }
    return pickRegionPickerSessions(scoped, limit);
};
