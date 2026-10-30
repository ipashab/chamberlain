import React from 'react';
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  type DragEndEvent,
} from '@dnd-kit/core';
import { Icon } from "@/components/icon/Icon";
import { sessionFolderCollision } from './sessionFolderCollision';
import { getSessionFolderIdentityKey, isArchivedFolderScope } from '../sessions/sessionFolderIdentity';
import { resolveEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { trackRegionDrop, applyRegionDrop, resolveRegionDropTarget, type RegionDropGesture } from '@/components/layout/regionDropGesture';

/** Body class shown while a session row drag is live; CSS turns every
 * context-panel region into a visible drop target. */
const SESSION_DRAG_BODY_CLASS = 'oc-session-dragging';


type SessionFolderDropTarget = {
  folderId: string;
  scopeKey: string;
  ownerKey: string;
};

/**
 * The folder owners that have a folder a session can be dropped into. A row
 * whose owner has none does not drag at all: a drag with nowhere to land only
 * swallowed the click that started it. Without a provider every row drags.
 */
const SessionFolderOwnersContext = React.createContext<ReadonlySet<string> | null>(null);

export const SessionFolderOwnersProvider: React.FC<{
  ownerKeys: readonly string[];
  children: React.ReactNode;
}> = ({ ownerKeys, children }) => {
  // Keyed by content: the row model is rebuilt often, and a new set each time
  // would re-render every draggable row.
  const ownersKey = [...new Set(ownerKeys)].sort().join('\n');
  const owners = React.useMemo(() => new Set(ownersKey ? ownersKey.split('\n') : []), [ownersKey]);
  return <SessionFolderOwnersContext.Provider value={owners}>{children}</SessionFolderOwnersContext.Provider>;
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
  const folderOwners = React.useContext(SessionFolderOwnersContext);
  // A folder drop stays an owner affair; a workspace drop needs a directory
  // the chat tab can resolve. A session that can land in neither never drags:
  // such a drag had nowhere to land and only swallowed the click that
  // started it.
  const canLandInFolder = folderOwners === null || (ownerKey !== null && folderOwners.has(ownerKey));
  const canLandOnWorkspace = !archivedBucket && sessionDirectory != null;
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `session-drag:${dragKey ?? sessionId}`,
    disabled: archivedBucket || (!canLandInFolder && !canLandOnWorkspace),
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
  // While a session is dragged, its release over the workspace lands through
  // the shared region gesture: a region's middle opens the chat there, an
  // edge splits the region and opens it beside what was already there.
  const regionDropRef = React.useRef<RegionDropGesture | null>(null);
  const cancelRegionDrop = () => {
    regionDropRef.current?.cancel();
    regionDropRef.current = null;
  };
  // An unmount mid-drag (a project switch) must not leave the gesture's
  // pointer listener behind with a live payload in the shared store.
  React.useEffect(() => () => cancelRegionDrop(), []);
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
    if (activeData?.type !== 'session' || !activeData.sessionId) {
      cancelRegionDrop();
      return;
    }
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
      cancelRegionDrop();
      // SAFETY: the folderDrop guard above narrowed ownerKey to a string.
      const sourceOwnerKey = activeData.ownerKey as string;
      onSessionDroppedOnFolder(activeData.sessionId, {
        folderId: overData.folderId,
        scopeKey: overData.scopeKey,
        ownerKey: overData.ownerKey,
      }, sourceOwnerKey);
      return;
    }
    // No folder caught it: the shared region gesture answers where the release
    // sits on the layout — a region, its edge, or neither. Folders stay
    // sidebar affairs — the region path only needs a live session with a
    // directory the tab can resolve.
    if (!activeData.sessionDirectory || activeData.archivedBucket) {
      cancelRegionDrop();
      return;
    }
    const regionDrop = regionDropRef.current;
    regionDropRef.current = null;
    if (regionDrop?.finish()) return;
    // Fallback: the gesture's own pointer tracking may miss the last move, so
    // dnd-kit reports the exact release point — the drag started, moved by
    // its delta, exact for a pointer drag.
    const source = event.activatorEvent;
    if (!source || !('clientX' in source)) return;
    // SAFETY: PointerSensor activator events are mouse or pointer events,
    // and the `clientX` membership check above is what any other event fails.
    const start = source as MouseEvent;
    const target = resolveRegionDropTarget({ x: start.clientX + event.delta.x, y: start.clientY + event.delta.y });
    if (!target) return;
    const title = activeData.sessionTitle ?? '';
    const panelDirectory = resolveEffectiveDirectory() || activeData.sessionDirectory;
    applyRegionDrop(panelDirectory, {
      kind: 'session',
      directoryKey: panelDirectory,
      sessionId: activeData.sessionId,
      sessionDirectory: activeData.sessionDirectory,
      label: title,
    }, target);
  };

  const handleDragCancel = () => {
    setActiveDragId(null);
    setActiveDragWidth(null);
    setActiveDragHeight(null);
    cancelRegionDrop();
    endSessionDragFeedback();
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={sessionFolderCollision}
      onDragStart={(event) => {
        // SAFETY: drag payloads are created by DraggableSessionRow in this module.
        const data = event.active.data.current as { type?: string; sessionId?: string; sessionTitle?: string; sessionDirectory?: string | null; archivedBucket?: boolean } | undefined;
        if (data?.type === 'session' && data.sessionId) {
          setActiveDragId(data.sessionId);
          setActiveDragTitle(data.sessionTitle ?? 'Session');
          const width = event.active.rect.current.initial?.width;
          const height = event.active.rect.current.initial?.height;
          setActiveDragWidth(width ?? null);
          setActiveDragHeight(height ?? null);
          document.body.classList.add(SESSION_DRAG_BODY_CLASS);
          // The workspace side of the same drag: from here the shared region
          // gesture owns the layout side — its targets, and the drop.
          if (data.sessionDirectory && !data.archivedBucket) {
            const panelDirectory = resolveEffectiveDirectory() || data.sessionDirectory;
            regionDropRef.current?.cancel();
            regionDropRef.current = trackRegionDrop({
              kind: 'session',
              directoryKey: panelDirectory,
              sessionId: data.sessionId,
              sessionDirectory: data.sessionDirectory,
              label: data.sessionTitle ?? '',
            }, () => true);
          }
        }
      }}
      onDragCancel={handleDragCancel}
      onDragEnd={handleDragEnd}
    >
      {children}
      {/* The drag ghost's own overlay must not own the pointer: without this
          it sits fixed under the cursor and swallows the elementFromPoint the
          region targets read, and the regions' hover highlight too. */}
      <DragOverlay style={{ pointerEvents: 'none' }}>
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
