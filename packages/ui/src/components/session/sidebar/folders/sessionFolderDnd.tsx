import React from 'react';
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  type DragEndEvent,
} from '@dnd-kit/core';
import { Icon } from "@/components/icon/Icon";
import { getSessionFolderIdentityKey, isArchivedFolderScope } from '../sessions/sessionFolderIdentity';
import { useUIStore } from '@/stores/useUIStore';
import { resolveEffectiveDirectory } from '@/hooks/useEffectiveDirectory';

/** Body class shown while a session row drag is live; CSS turns every
 * context-panel region into a visible drop target. */
const SESSION_DRAG_BODY_CLASS = 'oc-session-dragging';

/** The region under a viewport point, by its leaf id, if there is one. */
const findSessionRegionLeaf = (x: number, y: number): string | null => {
  const leaf = document.elementFromPoint(x, y)?.closest('[data-region-leaf]') ?? null;
  const leafId = leaf?.getAttribute('data-region-leaf');
  return leafId ? leafId : null;
};

/**
 * The region a session release aims at, if it aims at one: the context-panel
 * region under the release point. dnd-kit reports neither the live pointer
 * nor a final pointer event, so the release point is where the drag started,
 * moved by its delta — exact for a pointer drag, whose delta is the pointer's
 * own movement.
 */
const findSessionRegionLeafAt = (event: {
    activatorEvent?: Event | undefined;
    delta: { x: number; y: number };
}): string | null => {
    const source = event.activatorEvent;
    if (!source || !('clientX' in source)) return null;
    // SAFETY: PointerSensor activator events are mouse or pointer events,
    // and the `clientX` membership check above is what any other event fails.
    const start = source as MouseEvent;
    return findSessionRegionLeaf(start.clientX + event.delta.x, start.clientY + event.delta.y);
};


type SessionFolderDropTarget = {
  folderId: string;
  scopeKey: string;
  ownerKey: string;
};

export const DraggableSessionRow: React.FC<{
  sessionId: string;
  dragKey?: string;
  ownerKey?: string | null;
  sessionDirectory: string | null;
  sessionTitle: string;
  archivedBucket?: boolean;
  children: React.ReactNode;
}> = ({ sessionId, dragKey, ownerKey = null, sessionDirectory, sessionTitle, archivedBucket = false, children }) => {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `session-drag:${dragKey ?? sessionId}`,
    disabled: archivedBucket,
    data: { type: 'session', sessionId, ownerKey, sessionDirectory, sessionTitle, archivedBucket },
  });

  const handlePointerDown = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.stopPropagation();
      if (listeners?.onPointerDown) {
        // SAFETY: dnd-kit registers a React pointer listener for this draggable handle.
        (listeners.onPointerDown as (event: React.PointerEvent) => void)(e);
      }
    },
    [listeners],
  );

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onPointerDown={handlePointerDown}
      className={`touch-pan-y select-none${isDragging ? ' opacity-30' : ''}`}
    >
      {children}
    </div>
  );
};

export const DroppableFolderWrapper: React.FC<{
  folderId: string;
  scopeKey: string;
  ownerKey: string | null;
  disabled?: boolean;
  children: (
    droppableRef: (node: HTMLElement | null) => void,
    isOver: boolean,
  ) => React.ReactNode;
}> = ({ folderId, scopeKey, ownerKey, disabled = false, children }) => {
  const { setNodeRef, isOver } = useDroppable({
    id: `folder-drop:${getSessionFolderIdentityKey(scopeKey, folderId)}`,
    disabled: disabled || isArchivedFolderScope(scopeKey),
    data: { type: 'folder', folderId, scopeKey, ownerKey },
  });
  return <>{children(setNodeRef, isOver)}</>;
};

export const SessionFolderDndScope: React.FC<{
  scopeKey: string | null;
  ownerKey?: string | null;
  onSessionDroppedOnFolder: (sessionId: string, target: SessionFolderDropTarget, sourceOwnerKey: string) => void;
  children: React.ReactNode;
}> = ({ scopeKey, ownerKey = null, onSessionDroppedOnFolder, children }) => {
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
  );
  const [activeDragId, setActiveDragId] = React.useState<string | null>(null);
  const [activeDragTitle, setActiveDragTitle] = React.useState<string>('Session');
  const [activeDragWidth, setActiveDragWidth] = React.useState<number | null>(null);
  const [activeDragHeight, setActiveDragHeight] = React.useState<number | null>(null);

  if (!scopeKey) {
    return <>{children}</>;
  }

  const endSessionDragFeedback = () => {
    document.body.classList.remove(SESSION_DRAG_BODY_CLASS);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveDragId(null);
    setActiveDragWidth(null);
    setActiveDragHeight(null);
    endSessionDragFeedback();
    const { active, over } = event;
    // SAFETY: both payloads are created by the draggable and droppable components in this module.
    const activeData = active.data.current as { type?: string; sessionId?: string; ownerKey?: string | null; sessionDirectory?: string | null; sessionTitle?: string; archivedBucket?: boolean } | undefined;
    // SAFETY: both payloads are created by the draggable and droppable components in this module.
    const overData = (over?.data.current ?? null) as { type?: string; folderId?: string; scopeKey?: string; ownerKey?: string | null } | null;
    if (activeData?.type !== 'session' || !activeData.sessionId) return;
    const folderDrop = activeData.ownerKey
      && !activeData.archivedBucket
      && (!ownerKey || activeData.ownerKey === ownerKey)
      && overData?.type === 'folder'
      && overData.folderId
      && overData.scopeKey
      && overData.ownerKey
      && !isArchivedFolderScope(overData.scopeKey)
      && overData.ownerKey === activeData.ownerKey;
    if (folderDrop && overData?.folderId && overData.scopeKey && overData.ownerKey) {
      // SAFETY: the folderDrop guard above narrowed ownerKey to a string.
      const sourceOwnerKey = activeData.ownerKey as string;
      onSessionDroppedOnFolder(activeData.sessionId, {
        folderId: overData.folderId,
        scopeKey: overData.scopeKey,
        ownerKey: overData.ownerKey,
      }, sourceOwnerKey);
      return;
    }
    // No folder caught it: a release over a context-panel region opens the
    // session's chat there. Folders stay sidebar affairs — the region path
    // only needs a live session with a directory the tab can resolve.
    if (!activeData.sessionDirectory || activeData.archivedBucket) return;
    const regionLeafId = findSessionRegionLeafAt(event);
    if (!regionLeafId) return;
    const title = activeData.sessionTitle ?? '';
    const panelDirectory = resolveEffectiveDirectory() ?? activeData.sessionDirectory;
    useUIStore.getState().openContextPanelTabToLeaf(panelDirectory, {
      mode: 'chat',
      dedupeKey: `session:${activeData.sessionId}`,
      label: title,
      sessionTitleFallback: title,
      targetDirectory: activeData.sessionDirectory,
    }, regionLeafId);
  };

  const handleDragCancel = () => {
    setActiveDragId(null);
    setActiveDragWidth(null);
    setActiveDragHeight(null);
    endSessionDragFeedback();
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={(event) => {
        // SAFETY: drag payloads are created by DraggableSessionRow in this module.
        const data = event.active.data.current as { type?: string; sessionId?: string; sessionTitle?: string } | undefined;
        if (data?.type === 'session' && data.sessionId) {
          setActiveDragId(data.sessionId);
          setActiveDragTitle(data.sessionTitle ?? 'Session');
          const width = event.active.rect.current.initial?.width;
          const height = event.active.rect.current.initial?.height;
          setActiveDragWidth(width ?? null);
          setActiveDragHeight(height ?? null);
          document.body.classList.add(SESSION_DRAG_BODY_CLASS);
        }
      }}
      onDragCancel={handleDragCancel}
      onDragEnd={handleDragEnd}
    >
      {children}
      <DragOverlay>
        {/* The ghost now always shows: a drag can also land on a workspace
            region far from the sidebar, and half the gesture's meaning is
            seeing what is being carried there. */}
        {activeDragId ? (
          <div
            style={{
              width: activeDragWidth ? `${activeDragWidth}px` : 'auto',
              height: activeDragHeight ? `${activeDragHeight}px` : 'auto',
            }}
            className="flex items-center rounded-lg border border-[var(--interactive-border)] bg-[var(--surface-elevated)] px-2.5 py-1 shadow-none pointer-events-none"
          >
            <Icon name="sticky-note" className="h-4 w-4 text-muted-foreground me-2 flex-shrink-0" />
            <div className="min-w-0 flex-1 truncate typography-ui-label font-normal text-foreground">
              {activeDragTitle}
            </div>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
};
