// The analysis flow's doing half: the memory that remembers which session
// reads a pull, and the one action that starts a reading. The asking text
// itself is `buildAnalysisPrompt`'s; nothing in here renders anything.
//
// The shape follows the plan-send precedent (PlanView): create a titled
// session in the current session's directory, initialize it the way new
// OpenChamber sessions are initialized, open it, send the prompt. The
// memory is one versioned JSON map under one storage key, the way the
// pinned-sessions store does it — the pull's url is the natural key, and
// losing it only costs the footnotes, never the analysis session itself.

import { z } from 'zod';

import { getSafeStorage } from '@/stores/utils/safeStorage';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSelectionStore } from '@/sync/selection-store';
import { useSessionUIStore } from '@/sync/session-ui-store';

import type { BitbucketPullView } from '@/lib/bitbucket/pull-view-api';
import { fetchMagicPromptOverrides, getDefaultMagicPromptTemplate, type MagicPromptId } from '@/lib/magicPrompts';
import { analysisSessionTitle, buildAnalysisPrompt, type AnalysisScope } from './pullAnalysis';

/** The settings entry whose override replaces the default judging text. */
const ANALYSIS_METHODOLOGY_PROMPT_ID: MagicPromptId = 'bitbucket.pull.analysis.methodology';

/**
 * The methodology the analysis opens with: the user's override when the
 * Magic Prompts settings carry one, the default template otherwise. The
 * fetch is cached after the first read, so of every analysis only the
 * opening moment pays for it.
 */
const effectiveAnalysisMethodology = async (): Promise<string> => {
    const overrides = await fetchMagicPromptOverrides().catch((): Record<string, string> => ({}));
    const override = overrides[ANALYSIS_METHODOLOGY_PROMPT_ID];
    return typeof override === 'string' ? override : getDefaultMagicPromptTemplate(ANALYSIS_METHODOLOGY_PROMPT_ID);
};

const STORAGE_KEY = 'oc.bitbucket.pullAnalysis.v1';

/** Where a pull's reading lives: the session, its directory, when it began. */
export type PullAnalysisEntry = {
    sessionId: string;
    directory: string;
    startedAt: number;
};

export type PullAnalysisStartResult =
    | { ok: true; entry: PullAnalysisEntry }
    | { ok: false; reason: 'no-directory' | 'no-model' | 'rejected' };

type Memory = Record<string, PullAnalysisEntry>;

// Storage is an I/O boundary: whatever sits under the key is parsed, not
// probed — a foreign or half-written map reads as an empty memory.
const memorySchema = z.record(
    z.string(),
    z.object({
        sessionId: z.string(),
        directory: z.string(),
        startedAt: z.number().nullish(),
    }),
);

const readMemory = (): Memory => {
    const storage = getSafeStorage();
    let raw: string | null = null;
    try {
        raw = storage.getItem(STORAGE_KEY);
    } catch {
        return {};
    }
    if (!raw) return {};
    try {
        const parsed = memorySchema.safeParse(JSON.parse(raw));
        if (!parsed.success) return {};
        return Object.fromEntries(
            Object.entries(parsed.data).map(([url, entry]) => [
                url,
                { sessionId: entry.sessionId, directory: entry.directory, startedAt: entry.startedAt ?? 0 },
            ]),
        );
    } catch {
        return {};
    }
};

const writeMemory = (memory: Memory): void => {
    try {
        getSafeStorage().setItem(STORAGE_KEY, JSON.stringify(memory));
    } catch {
        // The map is a convenience: an unreadable or unwritable storage
        // costs the footnotes on reopen, never the reading itself.
    }
};

/** The session that last read this pull, if one was started from here. */
export const recallPullAnalysis = (url: string): PullAnalysisEntry | null =>
    readMemory()[url] ?? null;

/**
 * The analysis flow's one button action: a titled session in the current
 * session's directory, the chosen readings asked for in Russian with the
 * JSON block demanded back, and the panel's memory pointing at it. The
 * new session takes the stage in the chat the way a plan send does; the
 * pull panel stays where it was and watches from there.
 */
export const startPullAnalysis = async (
    view: BitbucketPullView,
    scope: AnalysisScope,
): Promise<PullAnalysisStartResult> => {
    const ui = useSessionUIStore.getState();
    const directory = ui.currentSessionId
        ? ui.getDirectoryForSession(ui.currentSessionId) ?? ui.lastLoadedDirectory
        : ui.lastLoadedDirectory;
    if (!directory) {
        return { ok: false, reason: 'no-directory' };
    }
    const config = useConfigStore.getState();
    if (!config.currentProviderId || !config.currentModelId) {
        return { ok: false, reason: 'no-model' };
    }

    const session = await ui.createSession(analysisSessionTitle(view), directory, undefined, {
        model: {
            providerID: config.currentProviderId,
            id: config.currentModelId,
            variant: config.currentVariant || undefined,
        },
        agent: config.currentAgentName || undefined,
    });
    if (!session?.id) {
        return { ok: false, reason: 'rejected' };
    }

    const entry: PullAnalysisEntry = {
        sessionId: session.id,
        directory: session.directory ?? directory,
        startedAt: Date.now(),
    };
    const memory = readMemory();
    memory[view.pull.url] = entry;
    writeMemory(memory);

    ui.initializeNewOpenChamberSession(session.id, config.agents ?? []);
    const selection = useSelectionStore.getState();
    selection.saveSessionModelSelection(session.id, config.currentProviderId, config.currentModelId);
    ui.setCurrentSession(session.id, entry.directory);

    await ui.sendMessage(
        buildAnalysisPrompt(view, scope, await effectiveAnalysisMethodology()),
        config.currentProviderId,
        config.currentModelId,
        config.currentAgentName || undefined,
        undefined,
        undefined,
        undefined,
        config.currentVariant || undefined,
    );
    return { ok: true, entry };
};
