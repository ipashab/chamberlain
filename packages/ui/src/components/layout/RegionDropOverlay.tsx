import React from 'react';
import { createPortal } from 'react-dom';
import { isRightToLeft } from '@/lib/i18n';
import type { RegionDropTarget } from '@/lib/workspace/regionDropTargets';
import { useRegionDropStore } from './regionDropGesture';

type TargetFrame = { left: number; top: number; width: number; height: number };

const rectOf = (element: Element): TargetFrame | null => {
  const { left, top, width, height } = element.getBoundingClientRect();
  return width > 0 && height > 0 ? { left, top, width, height } : null;
};

const sameFrame = (a: TargetFrame | null, b: TargetFrame | null): boolean => {
  if (!a || !b) return a === b;
  return Math.abs(a.left - b.left) < 0.5
    && Math.abs(a.top - b.top) < 0.5
    && Math.abs(a.width - b.width) < 0.5
    && Math.abs(a.height - b.height) < 0.5;
};

const frameOfSplit = (rect: TargetFrame, edge: 'start' | 'end' | 'top' | 'bottom', rtl: boolean): TargetFrame => {
  // 'start' names the inline-start edge, which the physical left is only in
  // LTR; 'end' is its mirror.
  const startOnPhysicalLeft = edge === 'start' ? !rtl : rtl;
  const halfWidth = rect.width / 2;
  switch (edge) {
    case 'top':
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height / 2 };
    case 'bottom':
      return { left: rect.left, top: rect.top + rect.height / 2, width: rect.width, height: rect.height / 2 };
    case 'start':
    case 'end':
      return startOnPhysicalLeft
        ? { left: rect.left, top: rect.top, width: halfWidth, height: rect.height }
        : { left: rect.left + halfWidth, top: rect.top, width: halfWidth, height: rect.height };
  }
};

/**
 * The live target of a layout drop, drawn over the region the pointer names:
 * a frame over the whole region for a move, a band over the half the new
 * region will take for a split. Pointer-transparent — the drag source keeps
 * the gesture. The frame re-measures while the drag runs, and only re-renders
 * when its own geometry actually changes.
 */
export const RegionDropOverlay: React.FC = () => {
  const payload = useRegionDropStore((state) => state.payload);
  const target = useRegionDropStore((state) => state.target);

  const [frame, setFrame] = React.useState<TargetFrame | null>(null);

  React.useEffect(() => {
    if (!payload || !target) {
      setFrame((prev) => (prev === null ? prev : null));
      return undefined;
    }
    const t: RegionDropTarget = target;
    const measure = () => {
      const element = t.regionId === 'chat'
        ? document.querySelector('[data-workspace-chat]')
        : document.querySelector(`[data-region-leaf="${CSS.escape(t.regionId)}"]`);
      const rect = element ? rectOf(element) : null;
      if (!element || !rect) {
        setFrame((prev) => (prev === null ? prev : null));
        return;
      }
      const next = t.action === 'move'
        ? rect
        : t.edge ? frameOfSplit(rect, t.edge, isRightToLeft(element)) : null;
      setFrame((prev) => (sameFrame(prev, next) ? prev : next));
    };
    measure();
    // The pointer keeps the gesture; these listeners only re-measure, so a
    // resize or a layout settling mid-drag cannot leave the frame stale.
    window.addEventListener('resize', measure);
    window.addEventListener('pointermove', measure);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('pointermove', measure);
    };
  }, [payload, target]);

  if (!frame) return null;

  return createPortal(
    <div
      className="pointer-events-none fixed z-50 rounded-[10px] border-2 border-primary bg-primary/10"
      style={{ left: frame.left, top: frame.top, width: frame.width, height: frame.height }}
      aria-hidden="true"
    />,
    document.body,
  );
};
