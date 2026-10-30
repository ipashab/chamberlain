/**
 * Where a dragged thing can land on the workspace layout, by pointer point.
 *
 * A region (a layout leaf, or the chat held by the `chat` node — its id is
 * `'chat'`) takes a release in two ways: over its middle the dragged thing
 * becomes a tab of that region; over a border quarter of the same region the
 * release splits the region in two along that edge and the new region takes
 * the place the pointer points into, so the dragged thing lands beside —
 * never over — the content that was already there.
 *
 * The hit test is pure: rects and directions come in, a target comes out.
 * Physical x is what a pointer event and getBoundingClientRect speak; the
 * 'start'/'end' edges are logical, flipped by the layout's direction, because
 * a split's placement is logical (the first child of a row renders at the
 * inline-start side).
 */

/** Shapes the hit test takes and returns: pure data, no DOM. */
type RegionRect = { left: number; top: number; width: number; height: number };
type RegionPoint = { x: number; y: number };

/** How much of a region's each side counts as its split edge. */
const REGION_EDGE_SHARE = 0.25;

/** The target leaf, spelled the way ids exist in the DOM and the store. */
export type RegionDropTarget = {
  /** `'chat'` for the chat's region, else the leaf's id. */
  regionId: string;
  action: 'move' | 'split';
  /** Which edge the pointer sits in; present for a split. */
  edge?: 'start' | 'end' | 'top' | 'bottom';
};

type RegionBand = { x: number; y: number };

const edgeBand = (rect: RegionRect, share: number): RegionBand => ({
  x: rect.width * share,
  y: rect.height * share,
});

const inRect = (rect: RegionRect, point: RegionPoint): boolean => (
  point.x >= rect.left
  && point.x < rect.left + rect.width
  && point.y >= rect.top
  && point.y < rect.top + rect.height
);

/**
 * The target a point names in one region, or null when the point is outside
 * it. `isRtl` speaks for the region's own layout direction.
 */
export const hitTestRegionDropTarget = (
  rect: RegionRect,
  regionId: string,
  point: RegionPoint,
  isRtl: boolean,
  share: number = REGION_EDGE_SHARE,
): RegionDropTarget | null => {
  if (!inRect(rect, point)) return null;
  const band = edgeBand(rect, share);
  const fromLeft = point.x - rect.left;
  const fromTop = point.y - rect.top;
  if (fromTop < band.y) return { regionId, action: 'split', edge: 'top' };
  if (fromTop >= rect.height - band.y) return { regionId, action: 'split', edge: 'bottom' };
  // Physical sides flip their logical meaning in RTL: the left edge of an
  // RTL row is its inline end.
  const nearLeft = fromLeft < band.x;
  const nearRight = fromLeft >= rect.width - band.x;
  if (nearLeft || nearRight) {
    const edge = nearLeft !== isRtl ? 'start' : 'end';
    return { regionId, action: 'split', edge };
  }
  return { regionId, action: 'move' };
};

/** The split a target's edge names: its axis and the new leaf's placement. */
export const splitOfRegionEdge = (edge: NonNullable<RegionDropTarget['edge']>): {
  axis: 'row' | 'column';
  placement: 'start' | 'end';
} => (
  edge === 'top' || edge === 'bottom'
    ? { axis: 'column', placement: edge === 'top' ? 'start' : 'end' }
    : { axis: 'row', placement: edge }
);
