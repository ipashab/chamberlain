import { z } from 'zod';
import type { StorageValue } from 'zustand/middleware';
import { isVSCodeRuntime } from '@/lib/desktop';
import type { MessageQueueState, QueuedMessage } from './messageQueueStore';

export type FollowUpBehavior = 'steer' | 'queue';

export const DEFAULT_FOLLOW_UP_BEHAVIOR: FollowUpBehavior = 'queue';

const isFollowUpBehavior = (value: unknown): value is FollowUpBehavior => (
    value === 'steer' || value === 'queue'
);

const normalizeFollowUpBehavior = (
    value: unknown,
    legacyQueueModeEnabled?: boolean | null,
): FollowUpBehavior => {
    if (value === 'immediate') {
        return 'steer';
    }

    if (isFollowUpBehavior(value)) {
        return value;
    }

    if (legacyQueueModeEnabled === false) {
        return 'steer';
    }

    if (legacyQueueModeEnabled === true) {
        return 'queue';
    }

    return DEFAULT_FOLLOW_UP_BEHAVIOR;
};

// The queue the server owns never persists locally; flushes of the editor
// runtime do, and the merge below reads that same decision.
export const isServerOwnedMessageQueue = (): boolean => !isVSCodeRuntime();

type PersistedQueuedMessage = Omit<QueuedMessage, 'text'> & { text?: string };

type PersistedMessageQueueState = {
    queuedMessages?: Record<string, PersistedQueuedMessage[]>;
    quarantinedLegacyMessages?: Record<string, PersistedQueuedMessage[]>;
    followUpBehavior?: FollowUpBehavior;
    queueModeEnabled?: boolean;
};

const withDeliveryText = (queues: Record<string, PersistedQueuedMessage[]>): Record<string, QueuedMessage[]> => (
    Object.fromEntries(Object.entries(queues).map(([key, queue]) => [
        key,
        queue.map((message) => ({ ...message, text: message.text ?? message.content })),
    ]))
);

export type PersistedQueueStore = Pick<MessageQueueState, 'queuedMessages' | 'quarantinedLegacyMessages' | 'followUpBehavior'>;

export const migrateMessageQueueState = (persistedState: unknown, version: number): PersistedQueueStore => {
    const state = (persistedState ?? {}) as PersistedMessageQueueState;
    const legacyQueues = version < 2 ? (state.queuedMessages ?? {}) : {};
    return {
        queuedMessages: version < 2 ? {} : withDeliveryText(state.queuedMessages ?? {}),
        quarantinedLegacyMessages: withDeliveryText({
            ...(state.quarantinedLegacyMessages ?? {}),
            ...legacyQueues,
        }),
        followUpBehavior: normalizeFollowUpBehavior(state.followUpBehavior, state.queueModeEnabled ?? null),
    };
};

const storedQueueEnvelopeSchema = z.object({ state: z.unknown(), version: z.number().optional() });

let flushedQueues: Record<string, QueuedMessage[]> = {};

export const seedFlushedQueues = (queues: Record<string, QueuedMessage[]>): void => {
    flushedQueues = queues;
};

// Queue keys the store dropped since the last flush; the merge then removes
// them from what storage holds so a second window cannot resurrect them.
export const clearedQueueKeys = new Set<string>();

const readStoredQueues = (stored: string | null): Record<string, QueuedMessage[]> | null => {
    if (stored === null) return {};
    let json: unknown;
    try {
        json = JSON.parse(stored);
    } catch {
        return null;
    }
    const envelope = storedQueueEnvelopeSchema.safeParse(json);
    if (!envelope.success) return null;
    try {
        return migrateMessageQueueState(envelope.data.state, envelope.data.version ?? 0).queuedMessages ?? {};
    } catch {
        return null;
    }
};

const mergeQueuesWithStored = (
    pending: StorageValue<PersistedQueueStore>,
    stored: string | null,
): StorageValue<PersistedQueueStore> => {
    const ours = pending.state.queuedMessages;
    const previous = flushedQueues;
    flushedQueues = ours;
    const cleared = [...clearedQueueKeys];
    clearedQueueKeys.clear();
    if (isServerOwnedMessageQueue()) return pending;
    const storedQueues = readStoredQueues(stored);
    if (!storedQueues) return pending;
    const queuedMessages = { ...storedQueues };
    for (const key of cleared) {
        if (!ours[key]) delete queuedMessages[key];
    }
    for (const key of new Set([...Object.keys(previous), ...Object.keys(ours)])) {
        if (ours[key] === previous[key]) continue;
        const queue = ours[key];
        if (queue) queuedMessages[key] = queue;
        else delete queuedMessages[key];
    }
    return { ...pending, state: { ...pending.state, queuedMessages } };
};

export { mergeQueuesWithStored };
