// The spec-draft flow's doing half: the memory that remembers which session
// reads an issue, and the one action that starts a reading. The asking text
// itself is `buildIssueSpecPrompt`'s; nothing in here renders anything.
//
// The shape follows the plan-send precedent (PlanView) and the pull
// analysis flow: create a titled session in the current session's
// directory, initialize it the way new OpenChamber sessions are
// initialized, open it, send the prompt. The memory is one versioned
// JSON map under one storage key — the issue's url is the natural key,
// and losing it only costs the card, never the spec session itself.

import { z } from 'zod';

import { getSafeStorage } from '@/stores/utils/safeStorage';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSelectionStore } from '@/sync/selection-store';
import { useSessionUIStore } from '@/sync/session-ui-store';

import type { JiraIssueView } from '@/lib/jira/issue-view-api';
import { fetchMagicPromptOverrides, getDefaultMagicPromptTemplate, type MagicPromptId } from '@/lib/magicPrompts';
import { buildIssueSpecPrompt, issueSpecSessionTitle } from './issueSpec';

/** The settings entry whose override replaces the default instructions. */
const SPEC_METHODOLOGY_PROMPT_ID: MagicPromptId = 'jira.issue.spec.methodology';

/**
 * The instructions the spec session opens with: the user's override when
 * the Magic Prompts settings carry one, the default template otherwise.
 * The fetch is cached after the first read, so of every spec only the
 * opening moment pays for it.
 */
const effectiveSpecMethodology = async (): Promise<string> => {
    const overrides = await fetchMagicPromptOverrides().catch((): Record<string, string> => ({}));
    const override = overrides[SPEC_METHODOLOGY_PROMPT_ID];
    return typeof override === 'string' ? override : getDefaultMagicPromptTemplate(SPEC_METHODOLOGY_PROMPT_ID);
};

const STORAGE_KEY = 'oc.jira.issueSpec.v1';

/** Where an issue's reading lives: the session, its directory, when it began. */
export type IssueSpecEntry = {
    sessionId: string;
    directory: string;
    startedAt: number;
};

export type IssueSpecStartResult =
    | { ok: true; entry: IssueSpecEntry }
    | { ok: false; reason: 'no-directory' | 'no-model' | 'rejected' };

type Memory = Record<string, IssueSpecEntry>;

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
        // costs the card on reopen, never the reading itself.
    }
};

/** The session that last read this issue, if one was started from here. */
export const recallIssueSpec = (url: string): IssueSpecEntry | null =>
    readMemory()[url] ?? null;

/**
 * The spec flow's one button action: a titled session in the current
 * session's directory, the issue asked for in Russian with the JSON block
 * demanded back, and the panel's memory pointing at it. The new session
 * takes the stage in the chat the way a plan send does; the issue panel
 * stays where it was and watches from there.
 */
export const startIssueSpec = async (
    view: JiraIssueView,
): Promise<IssueSpecStartResult> => {
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

    const session = await ui.createSession(issueSpecSessionTitle(view), directory, undefined, {
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

    const entry: IssueSpecEntry = {
        sessionId: session.id,
        directory: session.directory ?? directory,
        startedAt: Date.now(),
    };
    const memory = readMemory();
    memory[view.issue.url] = entry;
    writeMemory(memory);

    ui.initializeNewOpenChamberSession(session.id, config.agents ?? []);
    const selection = useSelectionStore.getState();
    selection.saveSessionModelSelection(session.id, config.currentProviderId, config.currentModelId);
    ui.setCurrentSession(session.id, entry.directory);

    await ui.sendMessage(
        buildIssueSpecPrompt(view, await effectiveSpecMethodology()),
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
