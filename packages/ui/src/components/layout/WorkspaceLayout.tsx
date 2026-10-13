import React from 'react';
import { useI18n } from '@/lib/i18n';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { useRightSlotStore, setWorkStatusHost } from './rightSlot';
import { WORK_STATUS_COLUMN_WIDTH } from '@/components/chat/work-status/useWorkStatusVisibility';
import { ContextPanel } from './ContextPanel';
import {
  CHAT_NODE,
  edgeRegionShowsTabs,
  type SplitAxis,
  type WorkspaceNode,
} from '@/lib/workspace/layoutTree';

/** Keys the tree's nodes keep across rewrites; ids never change meaning. */
const nodeKey = (node: WorkspaceNode): string => (node.kind === 'split' ? node.id : node.kind === 'leaf' ? node.id : 'chat');

/** One divider between two neighbours of a split, dragged to rebalance them. */
const RegionGutter: React.FC<{
  directoryKey: string;
  splitId: string;
  axis: SplitAxis;
  leadingIndex: number;
}> = ({ directoryKey, splitId, axis, leadingIndex }) => {
  const { t, direction } = useI18n();
  const balanceLayoutSplit = useUIStore((state) => state.balanceLayoutSplit);
  const gutterRef = React.useRef<HTMLDivElement | null>(null);
  const [isDragging, setIsDragging] = React.useState(false);
  const isRow = axis === 'row';

  const handlePointerDown = React.useCallback((event: React.PointerEvent) => {
    event.preventDefault();
    setIsDragging(true);
  }, []);

  React.useEffect(() => {
    if (!isDragging) return undefined;

    // The trailing child's share of the whole split the pointer asks for is
    // trivial to read (`shareFromPointer`), but the store shares only the
    // pair, so measure the pair's own bounds: the gutter sits between its
    // two neighbours, and the pair is the union of their rects.
    const update = (event: PointerEvent) => {
      const gutter = gutterRef.current;
      if (!gutter) return;
      const leading = gutter.previousElementSibling;
      const trailing = gutter.nextElementSibling;
      if (!(leading instanceof HTMLElement) || !(trailing instanceof HTMLElement)) return;
      const a = leading.getBoundingClientRect();
      const b = trailing.getBoundingClientRect();
      const left = Math.min(a.left, b.left);
      const right = Math.max(a.right, b.right);
      const top = Math.min(a.top, b.top);
      const bottom = Math.max(a.bottom, b.bottom);
      let share: number | null = null;
      if (isRow) {
        const width = right - left;
        share = width > 0 ? (direction === 'rtl' ? event.clientX - left : right - event.clientX) / width : null;
      } else {
        const height = bottom - top;
        share = height > 0 ? (bottom - event.clientY) / height : null;
      }
      // The share is of the pair, which is what the store rebalances — the
      // rest of the split keeps its space whatever the pair's own size is.
      if (share !== null) {
        balanceLayoutSplit(directoryKey, splitId, leadingIndex, leadingIndex + 1, share);
      }
    };

    const stop = () => {
      setIsDragging(false);
      document.documentElement.style.cursor = '';
    };

    document.documentElement.style.cursor = isRow ? 'col-resize' : 'row-resize';
    window.addEventListener('pointermove', update);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    window.addEventListener('blur', stop);
    return () => {
      window.removeEventListener('pointermove', update);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      window.removeEventListener('blur', stop);
      document.documentElement.style.cursor = '';
    };
  }, [balanceLayoutSplit, direction, directoryKey, isDragging, isRow, leadingIndex, splitId]);

  return (
    <div
      ref={gutterRef}
      role="separator"
      aria-orientation={isRow ? 'vertical' : 'horizontal'}
      aria-label={t('contextPanel.region.gutterAria')}
      onPointerDown={handlePointerDown}
      className={cn(
        'group/gutter relative z-20 shrink-0',
        isRow ? 'w-1.5 cursor-col-resize' : 'h-1.5 cursor-row-resize',
      )}
    >
      <div
        className={cn(
          'absolute inset-0 transition-colors',
          isRow ? 'my-2 rounded-full' : 'mx-2 rounded-full',
          'bg-border/70 group-hover/gutter:bg-primary/50',
          isDragging && 'bg-primary/70',
        )}
      />
    </div>
  );
};

/**
 * One node of the workspace layout tree. A split lays its children out along
 * its axis with a resizable gutter between neighbours; a leaf draws its
 * panel frame; the chat draws what the caller gave it.
 */
const LayoutNode: React.FC<{
  node: WorkspaceNode;
  directoryKey: string;
  chatCovered: boolean;
  children: React.ReactNode;
}> = ({ node, directoryKey, chatCovered, children }) => {
  if (node.kind === 'chat') {
    return <>{children}</>;
  }
  if (node.kind === 'leaf') {
    return <ContextPanel leafId={node.id} chatCovered={chatCovered} />;
  }
  return (
    <div className={cn('relative flex min-h-0 min-w-0 flex-1 overflow-hidden', node.axis === 'row' ? undefined : 'flex-col')}>
      {node.children.map((child, index) => (
        <React.Fragment key={nodeKey(child)}>
          {index > 0 ? (
            <RegionGutter directoryKey={directoryKey} splitId={node.id} axis={node.axis} leadingIndex={index - 1} />
          ) : null}
          <div
            className="relative flex min-h-0 min-w-0 flex-col overflow-hidden"
            style={{
              flexGrow: node.fractions[index] * 1000,
              flexBasis: 0,
              // Hard pixel floors: flex cannot squeeze a region out of
              // existence while a drag or a window resize passes through.
              minWidth: node.axis === 'row' ? 240 : undefined,
              minHeight: node.axis === 'column' ? 120 : undefined,
            }}
          >
            <LayoutNode node={child} directoryKey={directoryKey} chatCovered={chatCovered}>
              {children}
            </LayoutNode>
          </div>
        </React.Fragment>
      ))}
    </div>
  );
};

/**
 * The workspace row: the layout tree beside tabs and the chat, however deep
 * the splits go, with the inline work-status card's column holding the end
 * edge whenever no region stands there.
 */
export const WorkspaceLayout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const effectiveDirectory = useEffectiveDirectory() ?? '';
  const directoryKey = React.useMemo(() => effectiveDirectory, [effectiveDirectory]);
  const layout = useUIStore((state) => (directoryKey ? state.contextPanelByDirectory[directoryKey]?.layout ?? CHAT_NODE : CHAT_NODE));
  const workStatusReserved = useRightSlotStore((state) => state.workStatusReserved);
  const chatCovered = useRightSlotStore((state) => state.chatCovered);

  // The card's column stands at the end edge only while no region shows
  // tabs there; a covered chat hides it with the chat it belongs to.
  const cardColumn = workStatusReserved && !chatCovered && !edgeRegionShowsTabs(layout, 'end');

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden" data-workspace-row="true" data-page-scroll-lock="true">
      <LayoutNode node={layout} directoryKey={directoryKey} chatCovered={chatCovered}>
        {children}
      </LayoutNode>
      <aside
        data-right-slot=""
        className="relative h-full shrink-0 overflow-clip bg-background transition-[width] motion-reduce:transition-none"
        style={{ width: cardColumn ? WORK_STATUS_COLUMN_WIDTH : 0 }}
      >
        {/* The inline work-status card's host, at the end edge of the row. */}
        <div ref={setWorkStatusHost} className={cn('absolute inset-y-0 inset-e-0 z-0 flex', chatCovered && 'invisible')} />
      </aside>
    </div>
  );
};
