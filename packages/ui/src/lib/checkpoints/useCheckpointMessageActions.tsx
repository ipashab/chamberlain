import React from 'react';
import { toast } from 'sonner';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import type { MessageExtraAction } from '@/components/chat/message/MessageBody';
import { useSessionCheckpoints } from '@/lib/checkpoints/useSessionCheckpoints';

// The row action turn checkpoints add to a user message: put the files the
// turn touched back to how they stood before it, leaving the conversation
// alone, and undo the last restore when there is one to undo. The actions
// read the registry lazily through the shared cache, so rows that never had a
// checkpoint (a turn without file edits, a server without the feature) render
// nothing and pay an idle map lookup each.

export const useCheckpointMessageActions = (
    sessionId: string | null,
    userMessageId: string | null,
): MessageExtraAction[] | undefined => {
    const { t } = useI18n();
    const { entryOf, restore } = useSessionCheckpoints(sessionId ?? '');
    const entry = userMessageId ? entryOf(userMessageId) : null;
    return React.useMemo(() => {
        if (!entry) return undefined;
        const actions: MessageExtraAction[] = [{
            id: 'checkpoint:restore',
            label: t('chat.messageBody.actions.restoreFiles'),
            icon: <Icon name="history" className="h-4 w-4" />,
            onSelect: () => {
                void restore(entry.id, false)
                    .then((outcome) => {
                        const changed = outcome.restored.length + outcome.removed.length;
                        const detail = outcome.skipped.length > 0
                            ? t('chat.messageBody.actions.restoreSkipped', {
                                changed,
                                skipped: outcome.skipped.length,
                            })
                            : t('chat.messageBody.actions.restoreDone', { changed });
                        toast.success(t('chat.messageBody.actions.restoreTitle'), { description: detail });
                    })
                    .catch((error) => {
                        // The server grades failures with its own words; those are
                        // shown rather than a generic shrug.
                        const detail = error instanceof Error
                            ? error.message
                            : t('chat.messageBody.actions.restoreFailed');
                        toast.error(t('chat.messageBody.actions.restoreTitle'), { description: detail });
                    });
            },
        }];
        if (entry.restored) {
            actions.push({
                id: 'checkpoint:undo',
                label: t('chat.messageBody.actions.undoRestore'),
                icon: <Icon name="corner-down-left" className="h-4 w-4" />,
                onSelect: () => {
                    void restore(entry.id, true)
                        .then(() => {
                            toast.success(t('chat.messageBody.actions.undoRestore'), {
                                description: t('chat.messageBody.actions.undoDone'),
                            });
                        })
                        .catch((error) => {
                            const detail = error instanceof Error
                                ? error.message
                                : t('chat.messageBody.actions.restoreFailed');
                            toast.error(t('chat.messageBody.actions.undoRestore'), { description: detail });
                        });
                },
            });
        }
        return actions;
    }, [entry, restore, t]);
};
