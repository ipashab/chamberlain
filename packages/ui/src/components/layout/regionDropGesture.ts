import { create } from 'zustand';
import { isRightToLeft } from '@/lib/i18n';
import {
  hitTestRegionDropTarget,
  splitOfRegionEdge,
  type RegionDropTarget,
} from '@/lib/workspace/regionDropTargets';
import { findLeaf } from '@/lib/workspace/layoutTree';
import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';

/** What is being dragged onto the layout. `session` opens a chat tab pinned
 *  to that session; the other two move what already exists. */
type RegionDropPayload =
  | { kind: 'tab'; directoryKey: string; tabId: string; label: string }
  | {
    kind: 'session';
    directoryKey: string;
    sessionId: string;
    sessionDirectory: string;
    label: string;
  }
  | { kind: 'region'; directoryKey: string; sourceLeafId: string; label: string };

/**
 * The live layout drop: what is carried, and the region its point names.
 * Sources write it as their pointer moves; `RegionDropOverlay` draws the
 * target, and the drop itself lands through `applyRegionDrop`.
 */
type RegionDropState = { payload: RegionDropPayload | null; target: RegionDropTarget | null };
export const useRegionDropStore = create<RegionDropState>(() => ({ payload: null, target: null }));

const regionElementUnder = (point: { x: number; y: number }): { id: string; element: Element } | null => {
  const hit = document.elementFromPoint(point.x, point.y);
  if (!hit) return null;
  const leaf = hit.closest('[data-region-leaf]');
  const leafId = leaf?.getAttribute('data-region-leaf');
  if (leaf && leafId) return { id: leafId, element: leaf };
  // The chat itself is a drop region too: a release on its edge splits it.
  const chat = hit.closest('[data-workspace-chat]');
  if (chat) return { id: 'chat', element: chat };
  return null;
};

/** The target a viewport point names on the live layout, or null.
 *  `excludeMoveRegionId` rules out the region a whole-region drag came from:
 *  a move onto itself is a no-op, so it must not read as a target either. */
export const resolveRegionDropTarget = (
  point: { x: number; y: number },
  excludeMoveRegionId?: string,
): RegionDropTarget | null => {
  const region = regionElementUnder(point);
  if (!region) return null;
  const { left, top, width, height } = region.element.getBoundingClientRect();
  if (width <= 0 || height <= 0) return null;
  const target = hitTestRegionDropTarget({ left, top, width, height }, region.id, point, isRightToLeft(region.element));
  if (!target) return null;
  // The chat region takes no move: it holds no tab strip to join. Only its
  // edges drop — a split that puts the chat's new neighbour right there.
  if (target.regionId === 'chat' && target.action === 'move') return null;
  // A region dragged over its own frame still splits there (the content
  // moves into the half the pointer names); only the no-op move drops out.
  if (target.action === 'move' && target.regionId === excludeMoveRegionId) return null;
  return target;
};

/**
 * Lands a resolved drop: the dragged thing moves into (or splits before)
 * the target region. True when the drop happened; a null target is not one.
 */
export const applyRegionDrop = (
  directoryKey: string,
  payload: RegionDropPayload,
  target: RegionDropTarget | null,
): boolean => {
  if (!target) return false;
  const directory = normalizeContextPanelDirectoryKey(directoryKey);
  if (!directory) return false;
  const ui = useUIStore.getState();
  let destLeafId: string | null = null;
  if (target.action === 'split' && target.edge) {
    const { axis, placement } = splitOfRegionEdge(target.edge);
    destLeafId = target.regionId === 'chat'
      ? ui.splitLayoutRegion(directory, 'chat', axis, 0.5, placement)
      : ui.splitLayoutRegion(directory, { leafId: target.regionId }, axis, 0.5, placement);
  } else {
    destLeafId = target.regionId;
  }
  if (!destLeafId) return false;

  if (payload.kind === 'tab') {
    ui.moveContextPanelTabToLeaf(directory, payload.tabId, destLeafId);
    return true;
  }
  if (payload.kind === 'session') {
    ui.openContextPanelTabToLeaf(directory, {
      mode: 'chat',
      dedupeKey: `session:${payload.sessionId}`,
      label: payload.label,
      sessionTitleFallback: payload.label,
      targetDirectory: payload.sessionDirectory,
    }, destLeafId);
    return true;
  }
  // A whole region: its tabs move together, in their leaf's order, so the
  // region keeps reading the same in its new place.
  if (payload.sourceLeafId === destLeafId && target.action === 'move') return true;
  const layout = useUIStore.getState().contextPanelByDirectory[directory]?.layout;
  const movingTabIds = (findLeaf(layout, payload.sourceLeafId)?.tabs ?? []).slice();
  for (const tabId of movingTabIds) {
    useUIStore.getState().moveContextPanelTabToLeaf(directory, tabId, destLeafId);
  }
  return true;
};

export type RegionDropGesture = {
  /** Ends the gesture. True when the drop was the region gesture's (the source does nothing more). */
  finish: () => boolean;
  cancel: () => void;
};

const beginFeedback = (payload: RegionDropPayload) => {
  useRegionDropStore.setState({ payload, target: null });
};

const endFeedback = () => {
  useRegionDropStore.setState({ payload: null, target: null });
};

const sameTarget = (a: RegionDropTarget | null, b: RegionDropTarget | null): boolean => {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.regionId === b.regionId && a.action === b.action && a.edge === b.edge;
};

const updateTarget = (point: { x: number; y: number }, payload: RegionDropPayload) => {
  // A whole region dragged over itself moves nothing; only an edge of its
  // own frame is a target there. Sessions and tabs land anywhere.
  const excludeMoveRegionId = payload.kind === 'region' ? payload.sourceLeafId : undefined;
  const next = resolveRegionDropTarget(point, excludeMoveRegionId);
  if (!sameTarget(useRegionDropStore.getState().target, next)) {
    useRegionDropStore.setState({ target: next });
  }
};

/**
 * Follows a drag a source already runs (a sortable tab strip). The targets
 * show while `isOutside` holds the pointer away from the source's own
 * reordering, and hide again when it comes back.
 */
export const trackRegionDrop = (
  payload: RegionDropPayload,
  isOutside: (point: { x: number; y: number }) => boolean,
): RegionDropGesture => {
  let active = false;
  const onMove = (event: PointerEvent) => {
    const point = { x: event.clientX, y: event.clientY };
    if (isOutside(point)) {
      if (!active) {
        active = true;
        beginFeedback(payload);
      }
      updateTarget(point, payload);
    } else if (active) {
      active = false;
      endFeedback();
    }
  };
  window.addEventListener('pointermove', onMove);
  const stop = () => window.removeEventListener('pointermove', onMove);
  return {
    finish: () => {
      stop();
      if (!active) return false;
      const { target } = useRegionDropStore.getState();
      endFeedback();
      return applyRegionDrop(payload.directoryKey, payload, target);
    },
    cancel: () => {
      stop();
      if (active) endFeedback();
    },
  };
};

/**
 * A whole region dragged by its header: nothing native drives the pointer,
 * so this gesture does — targets appear once the pointer moves `thresholdPx`
 * from `start` (a header click still clicks), and the drop lands wherever
 * the pointer releases.
 */
export const runRegionHeaderDrop = (
  payload: RegionDropPayload,
  start: { x: number; y: number },
  thresholdPx: number,
): RegionDropGesture => {
  let active = false;
  const onMove = (event: PointerEvent) => {
    const point = { x: event.clientX, y: event.clientY };
    if (!active) {
      if (Math.hypot(point.x - start.x, point.y - start.y) < thresholdPx) return;
      active = true;
      beginFeedback(payload);
    }
    updateTarget(point, payload);
  };
  const finish = () => {
    stop();
    if (!active) return false;
    const { target } = useRegionDropStore.getState();
    endFeedback();
    return applyRegionDrop(payload.directoryKey, payload, target);
  };
  const cancel = () => {
    stop();
    if (active) endFeedback();
  };
  const stop = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onFinish);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('blur', onCancel);
  };
  const onFinish = () => finish();
  const onCancel = () => cancel();
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onFinish);
  window.addEventListener('pointercancel', onCancel);
  window.addEventListener('blur', onCancel);
  return { finish, cancel };
};
