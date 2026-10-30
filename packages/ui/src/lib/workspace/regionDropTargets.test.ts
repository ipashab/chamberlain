/**
 * The region drop hit test: where a release point lands inside one region —
 * its middle (a move) or one of its edge quarters (a split there), with the
 * start/end edges read logically through the layout's direction.
 */
import { describe, expect, test } from 'bun:test';
import { hitTestRegionDropTarget, splitOfRegionEdge } from './regionDropTargets';

const rect = { left: 100, top: 100, width: 400, height: 200 };

describe('hitTestRegionDropTarget', () => {
  test('the middle is a move', () => {
    expect(hitTestRegionDropTarget(rect, 'leaf-1', { x: 200, y: 150 }, false)).toEqual({
      regionId: 'leaf-1',
      action: 'move',
    });
  });

  test('each edge quarter names its own split edge', () => {
    expect(hitTestRegionDropTarget(rect, 'leaf-1', { x: 200, y: 130 }, false)?.edge).toBe('top');
    expect(hitTestRegionDropTarget(rect, 'leaf-1', { x: 200, y: 270 }, false)?.edge).toBe('bottom');
    expect(hitTestRegionDropTarget(rect, 'leaf-1', { x: 150, y: 150 }, false)?.edge).toBe('start');
    expect(hitTestRegionDropTarget(rect, 'leaf-1', { x: 450, y: 150 }, false)?.edge).toBe('end');
  });

  test('in RTL the physical sides swap their logical names', () => {
    expect(hitTestRegionDropTarget(rect, 'leaf-1', { x: 150, y: 150 }, true)?.edge).toBe('end');
    expect(hitTestRegionDropTarget(rect, 'leaf-1', { x: 450, y: 150 }, true)?.edge).toBe('start');
  });

  test('a point outside the region names no target', () => {
    expect(hitTestRegionDropTarget(rect, 'leaf-1', { x: 50, y: 150 }, false)).toBeNull();
    expect(hitTestRegionDropTarget(rect, 'leaf-1', { x: 501, y: 100 }, false)).toBeNull();
  });

  test('every split answer names an axis and the new leaf\'s placement', () => {
    expect(splitOfRegionEdge('top')).toEqual({ axis: 'column', placement: 'start' });
    expect(splitOfRegionEdge('bottom')).toEqual({ axis: 'column', placement: 'end' });
    expect(splitOfRegionEdge('start')).toEqual({ axis: 'row', placement: 'start' });
    expect(splitOfRegionEdge('end')).toEqual({ axis: 'row', placement: 'end' });
  });
});
