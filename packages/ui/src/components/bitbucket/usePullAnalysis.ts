// Watching a pull's reading from the panel. The session runs wherever the
// chat happens; the panel only needs three things from it: that a reading
// was started (the memory), that it is still turning (the live status
// index), and what its last well-formed answer said (the message store,
// parsed by the contract in `pullAnalysis`). History is pulled once on
// sight and again when the turn settles, because a background session is
// not opened through the path that normally loads it.

import React from 'react';
import { useShallow } from 'zustand/react/shallow';

import { flattenAssistantTextParts } from '@/lib/messages/messageText';
import { useSessionTurnActivity } from '@/sync/global-session-status';
import { fetchMessagesForSession } from '@/sync/session-actions';
import { useDirectorySync, useSessionMessages } from '@/sync/sync-context';
import type { State } from '@/sync/types';
import { useSessionUIStore } from '@/sync/session-ui-store';

import type { BitbucketPullView } from '@/lib/bitbucket/pull-view-api';
import { parseAnalysisResult, previousReadingDigest, type AnalysisScope, type PullAnalysis } from './pullAnalysis';
import { recallPullAnalysis, recallPullAnalysisHistory, startPullAnalysis, type PullAnalysisEntry, type PullAnalysisStartResult } from './pullAnalysisSession';

export type PullAnalysisState = {
    /** The remembered reading of this pull, if one was started. */
    entry: PullAnalysisEntry | null;
    /** Every reading this pull went through, newest first. */
    history: PullAnalysisEntry[];
    /** The last answer that fit the contract; null while unreadable. */
    analysis: PullAnalysis | null;
    /** The reading session is mid-turn right now. */
    analyzing: boolean;
    /** A reading exists and its session is quiet. */
    finished: boolean;
    /** Start (or restart) the reading — the last answer and any attached brief ride along. */
    start: (scope: AnalysisScope, brief: { title: string; material: string } | null) => Promise<PullAnalysisStartResult>;
    /** Put a reading session on stage in the chat; the newest by default. */
    openSession: (entry?: PullAnalysisEntry) => void;
};

export const usePullAnalysis = (view: BitbucketPullView | null): PullAnalysisState => {
    const url = view?.pull.url ?? null;
    const [history, setHistory] = React.useState<PullAnalysisEntry[]>(
        () => (url ? recallPullAnalysisHistory(url) : []),
    );

    // The memory answers per pull: switching selects moves the reading
    // being watched to whatever that pull left behind.
    React.useEffect(() => {
        setHistory(url ? recallPullAnalysisHistory(url) : []);
    }, [url]);

    const entry = history[0] ?? null;

    const sessionId = entry?.sessionId ?? '';
    const messages = useSessionMessages(sessionId, entry?.directory);
    const activity = useSessionTurnActivity(sessionId);
    const analyzing = sessionId !== '' && activity !== null;

    // A reading watched from the side is not "opened", so nobody loads its
    // history; pull it on sight, and once more when the turn settles so the
    // final answer is in the store even if a live event was missed.
    React.useEffect(() => {
        if (!entry) return;
        void fetchMessagesForSession(entry.sessionId, entry.directory);
    }, [entry, analyzing]);

    // The store keeps message bodies in its parts slice, keyed by message
    // id: read every assistant reply's text through one shallow selector,
    // so the panel wakes only when a reply the reading actually wrote lands.
    const assistantTexts = useDirectorySync(
        useShallow((state: State): string[] => {
            const texts: string[] = [];
            for (const record of messages) {
                if (record.role !== 'assistant') continue;
                const text = flattenAssistantTextParts(state.part[record.id] ?? []).trim();
                if (text) texts.push(text);
            }
            return texts;
        }),
        entry?.directory,
    );

    const analysis = React.useMemo<PullAnalysis | null>(() => {
        // Newest first, and only the newest answer that actually fits the
        // contract counts; earlier drafts inside the same reading are
        // exactly that — drafts.
        for (let index = assistantTexts.length - 1; index >= 0; index -= 1) {
            const parsed = parseAnalysisResult(assistantTexts[index] ?? '');
            if (parsed) return parsed;
        }
        return null;
    }, [assistantTexts]);

    // The history must grow the moment a reading starts, not on reopen —
    // the newest entry carries the session the panel is about to watch.
    const refreshHistory = React.useCallback(() => {
        setHistory(url ? recallPullAnalysisHistory(url) : []);
    }, [url]);

    const start = React.useCallback(async (scope: AnalysisScope, brief: { title: string; material: string } | null = null): Promise<PullAnalysisStartResult> => {
        if (!view) return { ok: false, reason: 'no-directory' };
        // A re-reading carries the last answer's digest, so the new session
        // re-judges instead of restating. The moment of the last start is
        // the "when" the digest speaks with; an answer that never parsed is
        // no previous opinion at all.
        const previous = analysis
            ? { digest: previousReadingDigest(analysis), at: history[0]?.startedAt ?? 0 }
            : null;
        const result = await startPullAnalysis(view, scope, previous, brief);
        if (result.ok) refreshHistory();
        return result;
    }, [view, analysis, history, refreshHistory]);

    const openSession = React.useCallback((target?: PullAnalysisEntry) => {
        const chosen = target ?? entry;
        if (!chosen) return;
        useSessionUIStore.getState().setCurrentSession(chosen.sessionId, chosen.directory);
    }, [entry]);

    return { entry, history, analysis, analyzing, finished: sessionId !== '' && !analyzing, start, openSession };
};
