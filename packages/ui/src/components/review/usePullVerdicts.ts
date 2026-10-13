// Watching many readings from the board. One row only needs the verdict
// its pull's last answer carried, and the board needs all of them at once
// — so this is the watching one level up from `usePullAnalysis`: the
// sessions' messages are loaded on sight (a board row is never "opened",
// so nobody else loads them), the verdicts are parsed from one
// directory's store, and the live turn index says which readings are
// still turning without the board polling anyone.

import React from 'react';
import { useShallow } from 'zustand/react/shallow';

import { flattenAssistantTextParts } from '@/lib/messages/messageText';
import { useGlobalSessionStatusStore } from '@/sync/global-session-status';
import { fetchMessagesForSession } from '@/sync/session-actions';
import { useDirectorySync } from '@/sync/sync-context';
import type { State } from '@/sync/types';

import { parseAnalysisResult } from '@/components/bitbucket/pullAnalysis';
import type { PullAnalysisEntry } from '@/components/bitbucket/pullAnalysisSession';
import type { PullVerdict } from './reviewBoard';

export type PullVerdictsWatch = {
    /** The verdict of every watched reading whose last answer fit the contract. */
    verdictBySessionId: Record<string, PullVerdict>;
    /** The watched readings whose sessions are mid-turn right now. */
    turningSessionIds: ReadonlySet<string>;
};

/**
 * The verdicts of the board's remembered readings. `wanted` is every
 * reading the rows name, whatever directory it ran in; `directory` is the
 * one store this watches — the majority the board computed, whose rows
 * update live while readings land. A reading outside it stays honest:
 * its row says «read», never a guessed verdict.
 */
export const usePullVerdicts = (
    wanted: readonly PullAnalysisEntry[],
    directory: string | null,
): PullVerdictsWatch => {
    // A session watched from the board is not opened, so nobody loads its
    // history; load it here, once per wanted set.
    React.useEffect(() => {
        for (const entry of wanted) void fetchMessagesForSession(entry.sessionId, entry.directory);
    }, [wanted]);

    // The store this subscribes to holds one directory's sessions; the
    // wanted entries of other directories read from their own stores'
    // state at fetch time but never update the board — that is the
    // majority-directory deal the board tells its rows about.
    const local = React.useMemo(
        () => (directory === null ? [] : wanted.filter((entry) => entry.directory === directory)),
        [wanted, directory],
    );

    const verdictBySessionId = useDirectorySync(
        React.useCallback((state: State) => {
            // The watch's own member type names the contract this builds —
            // the named owner of the verdict map, not an inline dictionary.
            const out: PullVerdictsWatch['verdictBySessionId'] = {};
            for (const entry of local) {
                const messages = state.message[entry.sessionId] ?? [];
                // Newest first, and only the newest answer that actually
                // fits the contract counts; earlier drafts inside the same
                // reading are exactly that — drafts.
                for (let index = messages.length - 1; index >= 0; index -= 1) {
                    const record = messages[index];
                    if (record?.role !== 'assistant') continue;
                    const text = flattenAssistantTextParts(state.part[record.id] ?? []).trim();
                    const parsed = parseAnalysisResult(text);
                    if (parsed?.overall) {
                        out[entry.sessionId] = parsed.overall.verdict;
                        break;
                    }
                }
            }
            return out;
        }, [local]),
        directory ?? undefined,
    );

    const turningSessionIds = useGlobalSessionStatusStore(
        useShallow((state) => {
            const live = new Set<string>();
            for (const entry of wanted) {
                if (state.activeSessionIds.has(entry.sessionId)) live.add(entry.sessionId);
            }
            return live;
        }),
    );

    return { verdictBySessionId, turningSessionIds };
};
