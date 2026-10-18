import { describe, expect, it } from 'vitest';

import {
  TEST_LOG_MAX_CHARS,
  TEST_NODE_LIMIT,
  applyTestEvent,
  consumeTestEventsLine,
  createTestTracker,
  finalizeTestTracker,
  testsProjection,
} from './test-results.js';

describe('applyTestEvent', () => {
  it('builds the pending skeleton from a collection event', () => {
    const tracker = createTestTracker();
    const changed = applyTestEvent(tracker, {
      type: 'collected',
      nodeIds: ['tests/test_a.py::test_one', 'tests/test_a.py::test_two[x1]'],
    });
    expect(changed).toBe(true);
    expect(tracker.collected).toBe(2);
    expect(testsProjection(tracker).nodes).toEqual([
      { nodeId: 'tests/test_a.py::test_one', status: 'pending', durationMs: null, log: null, error: null },
      { nodeId: 'tests/test_a.py::test_two[x1]', status: 'pending', durationMs: null, log: null, error: null },
    ]);
  });

  it('tracks a test from start to result without losing its slot', () => {
    const tracker = createTestTracker();
    applyTestEvent(tracker, { type: 'collected', nodeIds: ['t.py::test_x'] });
    applyTestEvent(tracker, { type: 'started', nodeId: 't.py::test_x' });
    expect(testsProjection(tracker).nodes[0].status).toBe('running');

    const changed = applyTestEvent(tracker, {
      type: 'result',
      nodeId: 't.py::test_x',
      status: 'failed',
      durationMs: 1234.6,
      log: '--- Captured stdout call ---\nhello',
      error: 'E   assert False',
    });
    expect(changed).toBe(true);
    expect(testsProjection(tracker).nodes).toEqual([
      {
        nodeId: 't.py::test_x',
        status: 'failed',
        durationMs: 1235,
        log: '--- Captured stdout call ---\nhello',
        error: 'E   assert False',
      },
    ]);
  });

  it('adds a result for a node collection never mentioned', () => {
    const tracker = createTestTracker();
    expect(applyTestEvent(tracker, { type: 'result', nodeId: 't.py::late', status: 'passed', durationMs: 1 })).toBe(true);
    expect(testsProjection(tracker).nodes.map((node) => node.nodeId)).toEqual(['t.py::late']);
  });

  it('reports an unknown outcome as an error and clips oversized payloads', () => {
    const tracker = createTestTracker();
    applyTestEvent(tracker, {
      type: 'result',
      nodeId: 't.py::weird',
      status: 'exploded',
      log: 'x'.repeat(TEST_LOG_MAX_CHARS + 500),
      error: null,
    });
    const node = testsProjection(tracker).nodes[0];
    expect(node.status).toBe('error');
    expect(node.log).toHaveLength(TEST_LOG_MAX_CHARS + 1); // clipped with the marker
    expect(node.log.endsWith('…')).toBe(true);
  });

  it('stops growing the node list at the cap but keeps the collected total', () => {
    const tracker = createTestTracker();
    const nodeIds = Array.from({ length: TEST_NODE_LIMIT + 10 }, (_, index) => `t.py::test_${index}`);
    applyTestEvent(tracker, { type: 'collected', nodeIds });
    expect(tracker.nodes).toHaveLength(TEST_NODE_LIMIT);
    expect(tracker.collected).toBe(TEST_NODE_LIMIT + 10);
  });

  it('ignores events that do not carry the shape they promise', () => {
    const tracker = createTestTracker();
    expect(applyTestEvent(tracker, null)).toBe(false);
    expect(applyTestEvent(tracker, 'started')).toBe(false);
    expect(applyTestEvent(tracker, { type: 'started' })).toBe(false);
    expect(applyTestEvent(tracker, { type: 'nonsense', nodeId: 't.py::x' })).toBe(false);
    expect(applyTestEvent(tracker, { type: 'started', nodeId: 't.py::x' })).toBe(true);
    expect(applyTestEvent(tracker, { type: 'started', nodeId: 't.py::x' })).toBe(false);
  });
});

describe('consumeTestEventsLine', () => {
  it('applies a well-formed JSONL line and shrugs off a broken one', () => {
    const tracker = createTestTracker();
    expect(consumeTestEventsLine(tracker, '{"type":"started","nodeId":"t.py::a"}')).toBe(true);
    expect(consumeTestEventsLine(tracker, '{"type":"started", nodeI')).toBe(false);
    expect(testsProjection(tracker).nodes.map((node) => node.status)).toEqual(['running']);
  });
});

describe('finalizeTestTracker', () => {
  it('settles running tests as errors and leaves pending ones alone', () => {
    const tracker = createTestTracker();
    applyTestEvent(tracker, { type: 'started', nodeId: 't.py::mid' });
    applyTestEvent(tracker, { type: 'collected', nodeIds: ['t.py::mid', 't.py::never'] });
    expect(finalizeTestTracker(tracker)).toBe(true);
    expect(testsProjection(tracker).nodes.map((node) => node.status)).toEqual(['error', 'pending']);
    expect(finalizeTestTracker(tracker)).toBe(false);
  });
});
