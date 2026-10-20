import React, { memo } from 'react';
import {
    DndContext,
    MouseSensor,
    TouchSensor,
    useSensor,
    useSensors,
    closestCenter,
    type DragEndEvent,
} from '@dnd-kit/core';
import {
    SortableContext,
    useSortable,
    verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { type BacklogItem } from '@/lib/session-backlog/backlogApi';
import { useSessionBacklog } from '@/lib/session-backlog/useSessionBacklog';

/**
 * One staged row of the expanded list: the queue number, the prompt, a grip
 * that drags it to a new place, arrows that move it by one, and the remove
 * cross. The row never reorders itself: the move goes to the store first and
 * the broadcast brings the new order back, so two windows cannot disagree
 * about the queue.
 */
const BacklogRow = memo(({ item, index, count, onMove, onRemove }: {
    item: BacklogItem;
    index: number;
    count: number;
    onMove: (itemId: string, position: number) => void;
    onRemove: (itemId: string) => void;
}) => {
    const { t } = useI18n();
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });
    return (
        <div
            ref={setNodeRef}
            className={cn('flex min-w-0 items-center gap-2 rounded-sm px-1 py-1 hover:bg-[var(--interactive-hover)]', isDragging && 'opacity-60')}
            style={{ transform: CSS.Translate.toString(transform), transition }}
        >
            <span className="w-4 shrink-0 text-end text-xs text-muted-foreground/70 oc-num">{index + 1}</span>
            <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{item.text}</span>
            <button
                type="button"
                className="shrink-0 cursor-grab touch-none select-none rounded-sm p-0.5 text-muted-foreground/50 hover:text-foreground"
                {...attributes}
                {...listeners}
                title={t('chat.backlog.actions.drag')}
                aria-label={t('chat.backlog.actions.drag')}
            >
                <Icon name="draggable" className="size-3.5" aria-hidden="true" />
            </button>
            <button
                type="button"
                disabled={index === 0}
                className="shrink-0 cursor-pointer rounded-sm p-0.5 text-muted-foreground/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
                onClick={() => onMove(item.id, index - 1)}
                title={t('chat.backlog.actions.moveUp')}
                aria-label={t('chat.backlog.actions.moveUp')}
            >
                <Icon name="arrow-up" className="size-3.5" aria-hidden="true" />
            </button>
            <button
                type="button"
                disabled={index === count - 1}
                className="shrink-0 cursor-pointer rounded-sm p-0.5 text-muted-foreground/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
                onClick={() => onMove(item.id, index + 1)}
                title={t('chat.backlog.actions.moveDown')}
                aria-label={t('chat.backlog.actions.moveDown')}
            >
                <Icon name="arrow-down" className="size-3.5" aria-hidden="true" />
            </button>
            <button
                type="button"
                className="shrink-0 cursor-pointer rounded-sm p-0.5 text-muted-foreground/70 hover:text-foreground"
                onClick={() => onRemove(item.id)}
                title={t('chat.backlog.actions.remove')}
                aria-label={t('chat.backlog.actions.remove')}
            >
                <Icon name="close" className="size-3.5" aria-hidden="true" />
            </button>
        </div>
    );
});

BacklogRow.displayName = 'BacklogRow';

/**
 * The session's staged backlog, as a top row of the composer next to the
 * queued messages: what waits, the count, and the drain the user starts by
 * their own word — a prompt is staged from the chat, by the agent, or by the
 * composer's stage button, and the strip follows the store's broadcast, so a
 * queue staged in another window is honest here. The list can stay collapsed
 * to one line; the rows open on the strip's own toggle, and reorder there by
 * grip drag or by arrow, each move going through the store's broadcast first.
 */
export const BacklogStrip = memo(({ sessionId }: { sessionId: string | null }) => {
    const { t } = useI18n();
    const { items, draining, loaded, remove, move, clear, run } = useSessionBacklog(sessionId);
    const [open, setOpen] = React.useState(false);
    // Desktop drags after a small move so a click still fires; touch drags
    // after a long press so a tap scrolls the list instead.
    const sensors = useSensors(
        useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
        useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    );

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

    const handleMove = (itemId: string, position: number) => {
        void move(itemId, position).catch((error) => {
            toast.error(error instanceof Error ? error.message : t('chat.backlog.moveFailed'));
        });
    };

    const handleRemove = (itemId: string) => {
        void remove(itemId).catch((error) => {
            toast.error(error instanceof Error ? error.message : t('chat.backlog.removeFailed'));
        });
    };

    const handleDragEnd = (event: DragEndEvent) => {
        const { active, over } = event;
        if (!over || active.id === over.id) return;
        const position = items.findIndex((item) => item.id === over.id);
        if (position === -1) return;
        handleMove(String(active.id), position);
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
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                    <SortableContext items={items.map((item) => item.id)} strategy={verticalListSortingStrategy}>
                        <div className="flex max-h-40 flex-col gap-0.5 overflow-y-auto px-3 pb-2">
                            {items.map((item, index) => (
                                <BacklogRow
                                    key={item.id}
                                    item={item}
                                    index={index}
                                    count={items.length}
                                    onMove={handleMove}
                                    onRemove={handleRemove}
                                />
                            ))}
                        </div>
                    </SortableContext>
                </DndContext>
            ) : null}
        </div>
    );
});

BacklogStrip.displayName = 'BacklogStrip';
