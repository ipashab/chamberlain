import { beforeEach, describe, expect, test } from 'bun:test';

import { leavesOf, type WorkspaceNode } from '@/lib/workspace/layoutTree';
import { useUIStore } from '@/stores/useUIStore';
import { revealDebugSurface } from '@/lib/debugger/useDebuggerSurfaceReveal';

const CHAT_ONLY: WorkspaceNode = { kind: 'chat' };
const panel = () => useUIStore.getState().contextPanelByDirectory['/repo'] ?? null;
const layout = (): WorkspaceNode => panel()?.layout ?? CHAT_ONLY;
const leaves = () => leavesOf(layout());
const tabIdOf = (predicate: (tab: { mode: string; targetPath: string | null }) => boolean): string =>
  (panel()?.tabs ?? []).find(predicate)?.id ?? '';
const debugTabIds = () => tabIdOf((tab) => tab.mode === 'debug');

// The narrowest split that holds both leaves: the split the reveal created.
const splitHolding = (firstLeafId: string, secondLeafId: string) => {
  const walk = (node: WorkspaceNode): WorkspaceNode[] => (node.kind === 'split' ? [node, ...node.children.flatMap(walk)] : []);
  return walk(layout()).find((node) => node.kind === 'split' && node.children.some((child) => child.kind === 'leaf' && child.id === firstLeafId)
    && node.children.some((child) => child.kind === 'leaf' && child.id === secondLeafId)) ?? null;
};

beforeEach(() => {
  useUIStore.setState({ contextPanelByDirectory: {} });
});

describe('revealDebugSurface', () => {
  test('a run whose file is open splits the file region and takes the new one below', () => {
    const store = useUIStore.getState();
    store.openContextFile('/repo', '/repo/tests/test_demo.py');
    const fileTabId = tabIdOf((tab) => tab.targetPath === '/repo/tests/test_demo.py');

    revealDebugSurface('/repo');

    const fileLeaf = leaves().find((leaf) => leaf.tabs.includes(fileTabId)) ?? null;
    const debugLeaf = leaves().find((leaf) => leaf.tabs.includes(debugTabIds())) ?? null;
    const split = splitHolding(fileLeaf?.id ?? '', debugLeaf?.id ?? '');
    expect(leaves()).toHaveLength(2);
    expect(fileLeaf?.tabs).toEqual([fileTabId]);
    expect(debugLeaf?.activeTabId).toBe(debugTabIds());
    // A column split stacks: the file's region above, the debugger below.
    expect(split?.kind).toBe('split');
    if (split?.kind !== 'split') return;
    expect(split.axis).toBe('column');
    const childLeafIds = split.children.map((child) => (child.kind === 'leaf' ? child.id : null));
    expect(childLeafIds[0]).toBe(fileLeaf?.id);
    expect(childLeafIds[1]).toBe(debugLeaf?.id);
  });

  test('with nothing to sit beside, the debug surface opens the way the rail opens it', () => {
    revealDebugSurface('/repo');

    expect(leaves()).toHaveLength(1);
    expect(debugTabIds()).not.toBe('');
    expect(panel()?.isOpen).toBe(true);
  });

  test('a surface already showing in a region is only re-activated', () => {
    const store = useUIStore.getState();
    store.openContextFile('/repo', '/repo/tests/test_demo.py');
    revealDebugSurface('/repo');
    const layoutAfterFirst = JSON.stringify(panel()?.layout);

    revealDebugSurface('/repo');

    expect(JSON.stringify(panel()?.layout)).toBe(layoutAfterFirst);
    expect(leaves()).toHaveLength(2);
    expect(debugTabIds()).not.toBe('');
  });

  test('the split goes under the most recently touched region, other regions keep theirs', () => {
    const store = useUIStore.getState();
    store.openContextSurface('/repo', 'git');
    store.splitLayoutRegion('/repo', { leafId: leaves()[0].id }, 'row', 0.5);
    store.moveContextPanelTabToLeaf('/repo', tabIdOf((tab) => tab.mode === 'git'), leaves()[1].id);
    store.openContextFile('/repo', '/repo/tests/test_demo.py');
    const fileTabId = tabIdOf((tab) => tab.targetPath === '/repo/tests/test_demo.py');

    revealDebugSurface('/repo');

    const fileLeaf = leaves().find((leaf) => leaf.tabs.includes(fileTabId)) ?? null;
    const debugLeaf = leaves().find((leaf) => leaf.tabs.includes(debugTabIds())) ?? null;
    const split = splitHolding(fileLeaf?.id ?? '', debugLeaf?.id ?? '');
    expect(leaves()).toHaveLength(3);
    expect(split?.kind).toBe('split');
    if (split?.kind !== 'split') return;
    expect(split.axis).toBe('column');
  });
});
