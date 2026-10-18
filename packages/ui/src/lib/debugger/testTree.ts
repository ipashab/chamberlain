// Turning the flat pytest node list into the tree the debug panel draws.
//
// A node id carries its own hierarchy — `dir/…/file.py::Class::test[case]` —
// so the tree is parsed from ids rather than shipped by the server. Directory
// segments, classes and the function become containers; a parametrized test
// hangs its cases under the function name, a plain test is its own leaf.

import type { DebugTestNode, DebugTestStatus } from './debugger-api';

export type TestTreeNode = {
  key: string;
  label: string;
  status: DebugTestStatus;
  durationMs: number | null;
  children: TestTreeNode[];
  // Set only on the node that IS a test: the case (or the plain test).
  test: DebugTestNode | null;
};

// Worst child decides what a container shows; a failed test outranks its own
// skipped teardown, a running one outranks its finished siblings.
const STATUS_PRECEDENCE: DebugTestStatus[] = ['failed', 'error', 'running', 'skipped', 'passed', 'pending'];

const worstStatus = (statuses: DebugTestStatus[]): DebugTestStatus => {
  let worst: DebugTestStatus = 'pending';
  for (const status of statuses) {
    if (STATUS_PRECEDENCE.indexOf(status) < STATUS_PRECEDENCE.indexOf(worst)) worst = status;
  }
  return worst;
};

// `test_name[a][b]` → function `test_name`, case label `[a][b]`.
const PARAM_SUFFIX = /^(.+?)((?:\[[^[\]]+\])+)$/;

const rollUp = (node: TestTreeNode): void => {
  if (node.test != null) {
    node.status = node.test.status;
    node.durationMs = node.test.durationMs ?? null;
    return;
  }
  for (const child of node.children) rollUp(child);
  if (node.children.length === 0) return;
  node.status = worstStatus(node.children.map((child) => child.status));
  const durations = node.children.map((child) => child.durationMs).filter((ms): ms is number => ms != null);
  node.durationMs = durations.length > 0 ? durations.reduce((total, ms) => total + ms, 0) : null;
};

export const buildTestTree = (nodes: DebugTestNode[]): TestTreeNode[] => {
  const root: TestTreeNode = { key: '', label: '', status: 'pending', durationMs: null, children: [], test: null };
  const byKey = new Map<string, TestTreeNode>();
  const childOf = (parent: TestTreeNode, label: string): TestTreeNode => {
    const key = `${parent.key}\u0000${label}`;
    const existing = byKey.get(key);
    if (existing != null) return existing;
    const created: TestTreeNode = { key, label, status: 'pending', durationMs: null, children: [], test: null };
    byKey.set(key, created);
    parent.children.push(created);
    return created;
  };

  for (const node of nodes) {
    const [filePart, ...scopeParts] = node.nodeId.split('::');
    let current = root;
    for (const segment of filePart.split('/').filter((part) => part.length > 0)) {
      current = childOf(current, segment);
    }
    // The last scope segment is the function; anything before it is classes.
    const scopes = scopeParts.length > 0 ? scopeParts : [filePart.includes('/') ? filePart.slice(filePart.lastIndexOf('/') + 1) : filePart];
    const lastScope = scopes[scopes.length - 1];
    for (const classScope of scopes.slice(0, -1)) current = childOf(current, classScope);
    const paramMatch = PARAM_SUFFIX.exec(lastScope);
    if (paramMatch == null) {
      childOf(current, lastScope).test = node;
    } else {
      const testNode = childOf(current, paramMatch[1]);
      childOf(testNode, paramMatch[2]).test = node;
    }
  }

  for (const child of root.children) rollUp(child);
  return root.children;
};

type TestRunCounts = {
  passed: number;
  failed: number;
  skipped: number;
  // Tests that reached any terminal state, failures included.
  done: number;
  // The collection total while known; the node count until it is.
  total: number;
};

export const countTestRun = (nodes: DebugTestNode[], collected: number | null | undefined): TestRunCounts => {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let done = 0;
  for (const node of nodes) {
    if (node.status === 'passed') passed += 1;
    // Fixture errors count against the failure tally the summary shows.
    if (node.status === 'failed' || node.status === 'error') failed += 1;
    if (node.status === 'skipped') skipped += 1;
    if (node.status !== 'pending' && node.status !== 'running') done += 1;
  }
  return { passed, failed, skipped, done, total: collected ?? nodes.length };
};
