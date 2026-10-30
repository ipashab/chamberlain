import { describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installHookTestDom } from '../test-utils/testDom';
import { useUIStore } from '@/stores/useUIStore';
import { CLOSED_ZONE_VIEW } from '@/lib/workspace/zones';

type Payload = { type: string; sessionId: string; ownerKey?: string; sessionDirectory?: string | null; sessionTitle?: string };
type DragEvent = {
  active: { data: { current: Payload }; rect?: { current: { initial?: { width?: number; height?: number } } } };
  over: { data: { current: { type: string; folderId: string; scopeKey: string; ownerKey: string } } } | null;
  activatorEvent?: Event;
  delta?: { x: number; y: number };
};
type DragStartEvent = DragEvent;

let handleDragEnd: ((event: DragEvent) => void) | null = null;
let handleDragStart: ((event: DragStartEvent) => void) | null = null;

mock.module('@dnd-kit/core', () => ({
  DndContext: ({ children, onDragEnd, onDragStart }: { children: React.ReactNode; onDragEnd: (event: DragEvent) => void; onDragStart: (event: DragStartEvent) => void }) => {
    handleDragEnd = onDragEnd;
    handleDragStart = onDragStart;
    return <>{children}</>;
  },
  DragOverlay: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  MouseSensor: class {},
  TouchSensor: class {},
  closestCenter: () => null,
  pointerWithin: () => [],
  rectIntersection: () => [],
  useSensor: () => null,
  useSensors: () => [],
  useDraggable: () => ({ attributes: {}, listeners: {}, setNodeRef: () => undefined, isDragging: false }),
  useDroppable: () => ({ setNodeRef: () => undefined, isOver: false }),
}));

// The drag ghost carries an icon; the hook test fixture has no sprite DOM.
mock.module('@/components/icon/Icon', () => ({
  Icon: () => <span data-icon-stub="" />,
}));

const { SessionFolderDndScope } = await import('./sessionFolderDnd');

/**
 * The fixture document is a stub without a body element or hit-testing;
 * install the pieces the drop paths read. `Object.defineProperty`
 * needs no type assertion, and the one-cast `Object.create` elements follow
 * the file's own `testDom` pattern. Returns a restore function.
 */
const installDragFixtureDom = (dom: ReturnType<typeof installHookTestDom>) => {
  // SAFETY: Object.create returns `any`; a fixture element only needs the
  // methods the region resolution reads, assigned right below.
  const region = Object.create(Object.prototype) as Element;
  Object.assign(region, {
    getAttribute: (name: string) => (name === 'data-region-leaf' ? 'leaf-1' : null),
    closest: (selector: string) => (selector === '[data-region-leaf]' ? region : null),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 300 }),
  });
  const describeBody = Object.getOwnPropertyDescriptor(document, 'body');
  const describeFromPoint = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');
  Object.defineProperty(document, 'body', { configurable: true, writable: true, value: { classList: { add: () => undefined, remove: () => undefined } } });
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, writable: true, value: () => region });
  return () => {
    Object.defineProperty(document, 'body', describeBody ?? { configurable: true, writable: true, value: undefined });
    Object.defineProperty(document, 'elementFromPoint', describeFromPoint ?? { configurable: true, writable: true, value: undefined });
    dom.restore();
  };
};

describe('SessionFolderDndScope public behavior', () => {
  test('routes a session-folder drop without depending on row edit or menu state', async () => {
    const dom = installHookTestDom();
    const restore = installDragFixtureDom(dom);
    const root = createRoot(dom.container);
    const drops: Array<{ sessionId: string; folderId: string }> = [];

    try {
      await act(async () => root.render(
        <SessionFolderDndScope
          scopeKey="/workspace"
          ownerKey="project-a"
          onSessionDroppedOnFolder={(sessionId, target) => drops.push({ sessionId, folderId: target.folderId })}
        >
          {null}
        </SessionFolderDndScope>,
      ));
      expect(handleDragEnd).not.toBeNull();

      await act(async () => handleDragEnd?.({
        active: { data: { current: { type: 'session', sessionId: 'session-a', ownerKey: 'project-a' } } },
        over: { data: { current: { type: 'folder', folderId: 'folder-a', scopeKey: '/workspace', ownerKey: 'project-a' } } },
      }));
      expect(drops).toEqual([{ sessionId: 'session-a', folderId: 'folder-a' }]);
    } finally {
      await act(async () => root.unmount());
      handleDragEnd = null;
      handleDragStart = null;
      restore();
    }
  });

  test('a session released over a context-panel region opens its chat there', async () => {
    const dom = installHookTestDom();
    const restore = installDragFixtureDom(dom);
    const root = createRoot(dom.container);
    const drops: Array<{ sessionId: string; folderId: string }> = [];
    const regionOpens: Array<{ leafId: string; dedupeKey: string; targetDirectory: string | null }> = [];
    const originalOpen = useUIStore.getState().openContextPanelTabToLeaf;
    useUIStore.setState({
      openContextPanelTabToLeaf: (directory, tab, leafId) => {
        regionOpens.push({ leafId, dedupeKey: tab.dedupeKey ?? '', targetDirectory: tab.targetDirectory ?? null });
      },
    });

    try {
      await act(async () => root.render(
        <SessionFolderDndScope
          scopeKey="/workspace"
          ownerKey="project-a"
          onSessionDroppedOnFolder={(sessionId, target) => drops.push({ sessionId, folderId: target.folderId })}
        >
          {null}
        </SessionFolderDndScope>,
      ));

      // The drag starts over the sidebar, moves onto the region, and the
      // release arrives with no folder underneath. The release point is the
      // activator event's coordinates moved by the drag delta; the fixture's
      // hit test resolves any viewport point to its region element, and this
      // one sits in the region's middle, where the release moves the session
      // into the region as a tab.
      await act(async () => handleDragStart?.({
        active: { data: { current: { type: 'session', sessionId: 'session-b', sessionDirectory: '/repo', sessionTitle: 'Board work' } }, rect: { current: { initial: { width: 40, height: 20 } } } },
        over: null,
      }));
      // SAFETY: Object.create returns `any`; the release-point math reads
      // exactly the two coordinates assigned right below.
      const activator = Object.create(Object.prototype) as MouseEvent;
      Object.assign(activator, { clientX: 5, clientY: 5 });
      await act(async () => handleDragEnd?.({
        active: { data: { current: { type: 'session', sessionId: 'session-b', ownerKey: 'project-a', sessionDirectory: '/repo', sessionTitle: 'Board work' } } },
        over: null,
        activatorEvent: activator,
        delta: { x: 195, y: 145 },
      }));

      expect(drops).toEqual([]);
      expect(regionOpens).toEqual([{ leafId: 'leaf-1', dedupeKey: 'session:session-b', targetDirectory: '/repo' }]);
    } finally {
      useUIStore.setState({ openContextPanelTabToLeaf: originalOpen });
      await act(async () => root.unmount());
      handleDragEnd = null;
      handleDragStart = null;
      restore();
    }
  });

  test('a session released on a region edge splits the region and opens beside it', async () => {
    const dom = installHookTestDom();
    const restore = installDragFixtureDom(dom);
    const root = createRoot(dom.container);
    const regionOpens: Array<{ leafId: string; dedupeKey: string }> = [];
    const originalOpen = useUIStore.getState().openContextPanelTabToLeaf;
    const originalPanels = useUIStore.getState().contextPanelByDirectory;
    useUIStore.setState({
      openContextPanelTabToLeaf: (directory, tab, leafId) => {
        regionOpens.push({ leafId, dedupeKey: tab.dedupeKey ?? '' });
      },
      contextPanelByDirectory: {
        '/repo': {
          isOpen: false,
          expanded: false,
          tabs: [],
          activeTabId: null,
          zones: { left: CLOSED_ZONE_VIEW, bottom: CLOSED_ZONE_VIEW },
          layout: { kind: 'leaf', id: 'leaf-1', tabs: [], activeTabId: null },
          modeLayouts: {},
          workspaceMode: 'chat',
          touchedAt: Date.now(),
        },
      },
    });

    try {
      await act(async () => root.render(
        <SessionFolderDndScope
          scopeKey="/workspace"
          ownerKey="project-a"
          onSessionDroppedOnFolder={() => undefined}
        >
          {null}
        </SessionFolderDndScope>,
      ));

      // The release point sits in the region's top edge band, so the drop
      // splits it along its column and the fresh region takes the upper half.
      // SAFETY: Object.create returns `any`; the release-point math reads
      // exactly the two coordinates assigned right below.
      const activator = Object.create(Object.prototype) as MouseEvent;
      Object.assign(activator, { clientX: 5, clientY: 5 });
      await act(async () => handleDragStart?.({
        active: { data: { current: { type: 'session', sessionId: 'session-c', sessionDirectory: '/repo', sessionTitle: 'Edge work' } }, rect: { current: { initial: { width: 40, height: 20 } } } },
        over: null,
      }));
      await act(async () => handleDragEnd?.({
        active: { data: { current: { type: 'session', sessionId: 'session-c', ownerKey: 'project-a', sessionDirectory: '/repo', sessionTitle: 'Edge work' } } },
        over: null,
        activatorEvent: activator,
        delta: { x: 195, y: 15 },
      }));

      expect(regionOpens).toHaveLength(1);
      const splitLeafId = regionOpens[0]?.leafId ?? '';
      expect(splitLeafId).not.toBe('leaf-1');
      const layout = useUIStore.getState().contextPanelByDirectory['/repo']?.layout ?? null;
      expect(layout?.kind).toBe('split');
    } finally {
      useUIStore.setState({ openContextPanelTabToLeaf: originalOpen, contextPanelByDirectory: originalPanels });
      await act(async () => root.unmount());
      handleDragEnd = null;
      handleDragStart = null;
      restore();
    }
  });
});
