import { describe, expect, test } from 'bun:test';

import type { DebugTestNode } from './debugger-api';
import { buildTestTree, countTestRun, type TestTreeNode } from './testTree';

const node = (nodeId: string, overrides: Partial<DebugTestNode> = {}): DebugTestNode => ({
  nodeId,
  status: 'pending',
  durationMs: null,
  log: null,
  error: null,
  ...overrides,
});

const treeLines = (tree: TestTreeNode[]): string[] =>
  tree.map((t) => `${t.label}(${t.status})[${t.children.length > 0 ? treeLines(t.children).join(',') : ''}]`);

describe('buildTestTree', () => {
  test('nests directories and hangs plain tests under their file', () => {
    const tree = buildTestTree([
      node('tests/integration/content/test_moviecard.py::test_valid', { status: 'passed', durationMs: 4000 }),
    ]);
    expect(treeLines(tree)).toEqual(['tests(passed)[integration(passed)[content(passed)[test_moviecard.py(passed)[test_valid(passed)[]]]]]']);
    const file = tree[0].children[0].children[0].children[0];
    expect(file.durationMs).toBe(4000);
  });

  test('splits parametrized cases under the function name', () => {
    const tree = buildTestTree([
      node('t/test_a.py::TestX::test_p[web-mobile]', { status: 'passed', durationMs: 234 }),
      node('t/test_a.py::TestX::test_p[smart-tv]', { status: 'failed', durationMs: 286, error: 'assert False' }),
    ]);
    const cases = tree[0].children[0].children[0].children;
    expect(cases.map((c) => c.label)).toEqual(['test_p']);
    expect(cases[0].children.map((c) => [c.label, c.status])).toEqual([
      ['[web-mobile]', 'passed'],
      ['[smart-tv]', 'failed'],
    ]);
    expect(cases[0].status).toBe('failed');
    expect(cases[0].durationMs).toBe(520);
  });

  test('lets the worst and running children decide the container status', () => {
    const tree = buildTestTree([
      node('a.py::t1', { status: 'passed' }),
      node('a.py::t2', { status: 'running' }),
      node('b.py::t3', { status: 'skipped' }),
      node('b.py::t4', { status: 'pending' }),
    ]);
    expect(tree.map((root) => root.status)).toEqual(['running', 'skipped']);
  });

  test('shares the directory prefix across files', () => {
    const tree = buildTestTree([
      node('tests/test_a.py::t1', { status: 'passed' }),
      node('tests/sub/test_b.py::t2', { status: 'failed' }),
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0].children.map((c) => c.label)).toEqual(['test_a.py', 'sub']);
    expect(tree[0].status).toBe('failed');
  });
});

describe('countTestRun', () => {
  test('tallies outcomes and prefers the collected total', () => {
    const counts = countTestRun([
      node('a::1', { status: 'passed' }),
      node('a::2', { status: 'failed' }),
      node('a::3', { status: 'error' }),
      node('a::4', { status: 'skipped' }),
      node('a::5', { status: 'running' }),
      node('a::6'),
    ], 12);
    expect(counts).toEqual({ passed: 1, failed: 2, skipped: 1, done: 4, total: 12 });
    expect(countTestRun([node('a::1', { status: 'passed' })], null).total).toBe(1);
  });
});
