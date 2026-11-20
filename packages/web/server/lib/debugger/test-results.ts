/**
 * Pytest result accumulation for the debug panel.
 *
 * The shipped pytest plugin (`pytest-reporter-plugin.js`) streams JSONL lines
 * from inside the pytest process; the service tails the events file and feeds
 * every complete line through `consumeTestEventsLine` here. The projection is
 * a flat ordered node list plus the collection total — the panel builds the
 * tree from node ids itself, so nothing here tracks hierarchy.
 *
 * Caps exist because one pytest invocation can reach thousands of tests:
 * `collected` keeps the true total even when the node list stopped growing.
 */

import { isPlainObject, isString } from '../shared/guards.js';

export const TEST_NODE_LIMIT = 5_000;
export const TEST_LOG_MAX_CHARS = 64_000;
const TEST_ERROR_MAX_CHARS = 32_000;

// The plugin's outcome vocabulary; anything else arrives only from a broken
// line and is reported as an error rather than dropped.
const TEST_STATUSES = new Set(['running', 'passed', 'failed', 'error', 'skipped']);

const isTestStatus = (value: unknown): value is Exclude<TestNodeStatus, 'pending'> =>
  isString(value) && TEST_STATUSES.has(value);

export type TestNodeStatus = 'pending' | 'running' | 'passed' | 'failed' | 'error' | 'skipped';

export interface TestNode {
  nodeId: string;
  status: TestNodeStatus;
  durationMs: number | null;
  log: string | null;
  error: string | null;
}

export interface TestTracker {
  collected: number | null;
  nodes: TestNode[];
  indexByKey: Map<string, TestNode>;
}

export interface TestProjection {
  collected: number | null;
  nodes: TestNode[];
}

const clip = (value: string, maxChars: number) =>
  value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;

export const createTestTracker = (): TestTracker => ({
  collected: null,
  nodes: [],
  indexByKey: new Map(),
});

const nodeFor = (tracker: TestTracker, nodeId: string): TestNode | null => {
  const existing = tracker.indexByKey.get(nodeId);
  if (existing != null) return existing;
  if (tracker.nodes.length >= TEST_NODE_LIMIT) return null;
  const node: TestNode = { nodeId, status: 'pending', durationMs: null, log: null, error: null };
  tracker.nodes.push(node);
  tracker.indexByKey.set(nodeId, node);
  return node;
};

/** Applies one decoded plugin event; true when the projection changed. */
export const applyTestEvent = (tracker: TestTracker, event: unknown): boolean => {
  if (!isPlainObject(event) || !isString(event.type)) return false;

  if (event.type === 'collected') {
    const nodeIds = Array.isArray(event.nodeIds) ? event.nodeIds.filter(isString) : [];
    tracker.collected = nodeIds.length;
    // The skeleton appears before the first test starts: ids in collection
    // order, every one of them pending.
    for (const nodeId of nodeIds) nodeFor(tracker, nodeId);
    return true;
  }

  if (!isString(event.nodeId)) return false;

  if (event.type === 'started') {
    const node = nodeFor(tracker, event.nodeId);
    if (node == null || node.status === 'running') return false;
    node.status = 'running';
    return true;
  }

  if (event.type === 'result') {
    const node = nodeFor(tracker, event.nodeId);
    if (node == null) return false;
    const status = isTestStatus(event.status) ? event.status : 'error';
    node.status = status;
    const rawDuration = event.durationMs;
    node.durationMs =
      typeof rawDuration === 'number' && Number.isFinite(rawDuration) && rawDuration >= 0
        ? Math.round(rawDuration)
        : null;
    node.log = isString(event.log) && event.log.length > 0 ? clip(event.log, TEST_LOG_MAX_CHARS) : null;
    node.error = isString(event.error) && event.error.length > 0 ? clip(event.error, TEST_ERROR_MAX_CHARS) : null;
    return true;
  }

  return false;
};

/** One JSONL line from the events file; a broken line is skipped, not fatal. */
export const consumeTestEventsLine = (tracker: TestTracker, line: string): boolean => {
  try {
    return applyTestEvent(tracker, JSON.parse(line));
  } catch {
    return false;
  }
};

/**
 * A run that died mid-test leaves that test 'running' forever; the end of the
 * process is what settles it. Pending nodes stay pending — they truthfully
 * never started.
 */
export const finalizeTestTracker = (tracker: TestTracker): boolean => {
  let changed = false;
  for (const node of tracker.nodes) {
    if (node.status === 'running') {
      node.status = 'error';
      changed = true;
    }
  }
  return changed;
};

export const testsProjection = (tracker: TestTracker): TestProjection => ({
  collected: tracker.collected,
  nodes: tracker.nodes.map(({ nodeId, status, durationMs, log, error }) => ({
    nodeId,
    status,
    durationMs,
    log,
    error,
  })),
});
