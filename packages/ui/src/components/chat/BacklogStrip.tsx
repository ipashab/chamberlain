import React, { memo } from 'react';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useSessionBacklog } from '@/lib/session-backlog/useSessionBacklog';

/**
 * The session's staged backlog, as a top row of the composer next to the
 * queued messages: what waits, the count, and the drain the user starts by
 * their own word — the stagings themselves happen in the chat, and the strip
 * follows the store's broadcast, so a queue staged in another window is
 * honest here. The list can stay collapsed to one line; the rows open on the
 * strip's own toggle.
 */
export const BacklogStrip = memo(({ sessionId }: { sessionId: string | null }) => {
    const { t } = useI18n();
    const { items, draining, loaded, remove, clear, run } = useSessionBacklog(sessionId);
    const [open, setOpen] = React.useState(false);

    if (!sessionId || !loaded || (items.length === 0 && !draining)) {
        return null;
    }

    const handleRun = () => {
        void run().then((outcome) => {
            if (!outcome) return;
            toast.success(t('chat.backlog.runStarted', { count: outcome.staged }));
        }).catch((error) => {
            toast.error(error instanceof Error ? error.message : t('chat.backlog.runFailed'));
        });
    };

    const handleClear = () => {
        void clear().catch((error) => {
            toast.error(error instanceof Error ? error.message : t('chat.backlog.clearFailed'));
        });
    };

    return (
        <div role="status" className="border-b border-border/60" data-session-id={sessionId}>
            <div className="flex h-10 min-w-0 items-center gap-2 ps-3 pe-1.5">
                {draining
                    ? <Spinner className="size-3.5 text-muted-foreground" aria-hidden="true" />
                    : <Icon name="list-check-2" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
                <button
                    type="button"
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-start text-sm text-foreground"
                    onClick={() => setOpen((value) => !value)}
                    aria-expanded={open}
                >
                    <span className="truncate">
                        {draining
                            ? t('chat.backlog.draining', { count: items.length })
                            : t('chat.backlog.staged', { count: items.length })}
                    </span>
                </button>
                {!draining && items.length > 0 ? (
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="shrink-0 text-muted-foreground hover:bg-transparent hover:text-foreground"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={handleRun}
                    >
                        <Icon name="play" className="size-3.5" aria-hidden="true" />
                        {t('chat.backlog.actions.run')}
                    </Button>
                ) : null}
                {items.length > 0 ? (
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="shrink-0 text-muted-foreground hover:bg-transparent hover:text-foreground"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={handleClear}
                        title={t('chat.backlog.actions.clear')}
                        aria-label={t('chat.backlog.actions.clear')}
                    >
                        <Icon name="close" className="size-3.5" aria-hidden="true" />
                    </Button>
                ) : null}
            </div>
            {open && items.length > 0 ? (
                <div className="flex max-h-40 flex-col gap-0.5 overflow-y-auto px-3 pb-2">
                    {items.map((item, index) => (
                        <div key={item.id} className="flex min-w-0 items-center gap-2 rounded-sm px-1 py-1 hover:bg-[var(--interactive-hover)]">
                            <span className="w-4 shrink-0 text-end text-xs text-muted-foreground/70 oc-num">{index + 1}</span>
                            <span className={cn('min-w-0 flex-1 truncate text-sm text-muted-foreground')}>{item.text}</span>
                            <button
                                type="button"
                                className="shrink-0 cursor-pointer rounded-sm p-0.5 text-muted-foreground/70 hover:text-foreground"
                                onClick={() => {
                                    void remove(item.id).catch((error) => {
                                        toast.error(error instanceof Error ? error.message : t('chat.backlog.removeFailed'));
                                    });
                                }}
                                title={t('chat.backlog.actions.remove')}
                                aria-label={t('chat.backlog.actions.remove')}
                            >
                                <Icon name="close" className="size-3.5" aria-hidden="true" />
                            </button>
                        </div>
                    ))}
                </div>
            ) : null}
        </div>
    );
});

BacklogStrip.displayName = 'BacklogStrip';
