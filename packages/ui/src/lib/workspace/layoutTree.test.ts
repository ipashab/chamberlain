import { describe, expect, test } from 'bun:test';
import {
  activateTab,
  balanceSplitAt,
  CHAT_NODE,
  closeLeaf,
  dropTab,
  ensureChat,
  findLeaf,
  leavesOf,
  moveTabToLeaf,
  openSurfaceInTree,
  renameTabsInTree,
  sanitizeTree,
  splitChat,
  splitLeaf,
  storedTreeSchema,
  treeFromZonedPanel,
  type LeafNode,
  type WorkspaceTree,
} from './layoutTree';

const leaf = (id: string, tabs: readonly string[] = [], activeTabId: string | null = null): LeafNode => ({
  kind: 'leaf',
  id,
  tabs,
  activeTabId: activeTabId ?? tabs.at(-1) ?? null,
});

const split = (id: string, axis: 'row' | 'column', children: readonly WorkspaceTree[], fractions?: readonly number[]): WorkspaceTree => ({
  kind: 'split',
  id,
  axis,
  fractions: fractions ?? Array.from({ length: children.length }, () => 1 / children.length),
  children,
});

// SAFETY: every tree these tests narrow with this helper was built by the
// split() or splitChat() path being asserted on, which writes that shape.
const asSplit = (node: WorkspaceTree): Extract<WorkspaceTree, { kind: 'split' }> =>
  node as Extract<WorkspaceTree, { kind: 'split' }>;

const tab = (id: string, mode: string) => ({ id, mode });

describe('workspace layout tree', () => {
  test('storage without a tree reads as the chat alone', () => {
    expect(storedTreeSchema.parse(undefined)).toBe(CHAT_NODE);
    expect(storedTreeSchema.parse(null)).toBe(CHAT_NODE);
    expect(storedTreeSchema.parse('left')).toBe(CHAT_NODE);
    expect(storedTreeSchema.parse({ kind: 'bogus' })).toBe(CHAT_NODE);
  });

  test('a stored tree round-trips through parse', () => {
    const tree = split('s1', 'row', [CHAT_NODE, leaf('l1', ['file:a'], 'file:a')], [0.7, 0.3]);
    expect(storedTreeSchema.parse(JSON.parse(JSON.stringify(tree)))).toEqual(tree);
  });

  test('parse repairs broken fractions and dangling active tabs', () => {
    const stored = {
      kind: 'split',
      id: 's1',
      axis: 'row',
      fractions: [3],
      children: [
        CHAT_NODE,
        { kind: 'leaf', id: 'l1', tabs: ['file:a', 'git'], activeTabId: 'gone' },
      ],
    };
    const parsed = storedTreeSchema.parse(stored);
    // A fraction list that does not match the children splits evenly.
    expect(asSplit(parsed).fractions).toEqual([0.5, 0.5]);
    expect(asSplit(parsed).children[1]).toMatchObject({ activeTabId: 'git' });
  });

  test('sanitize drops tabs the panel no longer holds', () => {
    const tree = split('s1', 'column', [CHAT_NODE, leaf('l1', ['file:a', 'git'], 'file:a')], [0.5, 0.5]);
    const cleaned = sanitizeTree(tree, new Set(['git']));
    expect(asSplit(cleaned).children[1]).toMatchObject({ tabs: ['git'], activeTabId: 'git' });
  });

  test('a split with one child collapses, so a lone chat strips its wrapper', () => {
    const wrapped = split('s1', 'row', [CHAT_NODE], [1]);
    expect(storedTreeSchema.parse(wrapped)).toEqual(CHAT_NODE);
  });

  test('a tree without a chat gets one at the head', () => {
    const chatless = split('s1', 'row', [leaf('l1', ['git'])], [1]);
    const fixed = ensureChat(chatless);
    expect(asSplit(fixed).axis).toBe('row');
    expect(asSplit(fixed).children[0]).toBe(CHAT_NODE);
    expect(leavesOf(fixed).map((node) => node.id)).toEqual(['l1']);
  });

  test('splitting the chat gives it a neighbor and keeps later splits in place', () => {
    const first = splitChat(CHAT_NODE, 'row', { newLeafId: 'right-leaf' });
    expect(first.tree).toMatchObject({ kind: 'split', axis: 'row', fractions: [0.5, 0.5] });
    expect(first.newLeaf.id).toBe('right-leaf');

    const second = splitChat(first.tree, 'column', { newLeafId: 'bottom-leaf', fraction: 0.25 });
    // The chat region split downward; the right leaf kept its share of the row.
    const row = asSplit(second.tree);
    expect(row.axis).toBe('row');
    const chatColumn = asSplit(row.children[0]);
    expect(chatColumn.axis).toBe('column');
    expect(chatColumn.fractions[1]).toBeGreaterThan(0.2);
    expect(row.children[1]).toMatchObject({ id: 'right-leaf' });
  });

  test('splitting a leaf leaves its tabs on its side of the divider', () => {
    const tree = split('s1', 'row', [CHAT_NODE, leaf('l1', ['git', 'diff'])], [0.6, 0.4]);
    const moved = splitLeaf(tree, 'l1', 'column', { newLeafId: 'l2', fraction: 0.25 });
    expect(moved).not.toBeNull();
    const columnNode = asSplit(asSplit(moved!.tree).children[1]);
    expect(columnNode.axis).toBe('column');
    expect(columnNode.children[0]).toMatchObject({ id: 'l1', tabs: ['git', 'diff'] });
    expect(columnNode.children[1]).toMatchObject({ id: 'l2', tabs: [] });
  });

  test('splitting an unknown leaf changes nothing', () => {
    const tree = split('s1', 'row', [CHAT_NODE, leaf('l1', ['git'])], [0.7, 0.3]);
    expect(splitLeaf(tree, 'nope', 'row')).toBeNull();
  });

  test('closing a leaf collapses the splits it leaves behind', () => {
    const tree = split('s1', 'row',
      [CHAT_NODE, split('s2', 'column', [leaf('l1', ['git']), leaf('l2', ['diff'])], [0.5, 0.5])],
      [0.6, 0.4]);
    const one = closeLeaf(tree, 'l2');
    // The column kept one child, so it collapsed into that leaf.
    expect(asSplit(one).children[1]).toMatchObject({ id: 'l1' });

    const none = closeLeaf(one, 'l1');
    expect(none).toBe(CHAT_NODE);
  });

  test('closing the last leaf of the whole layout leaves the chat, tabs stay in the shared list', () => {
    const tree = split('s1', 'row', [CHAT_NODE, leaf('l1', ['git'])], [0.7, 0.3]);
    expect(closeLeaf(tree, 'l1')).toBe(CHAT_NODE);
  });

  test('a tab moves between leaves and activates at its target', () => {
    const tree = split('s1', 'row',
      [CHAT_NODE, split('s2', 'column', [leaf('l1', ['git', 'diff'], 'git'), leaf('l2', ['file:a'])], [0.5, 0.5])],
      [0.7, 0.3]);
    const moved = moveTabToLeaf(tree, 'git', 'l2', { index: 0 });
    const columnNode = asSplit(asSplit(moved).children[1]);
    expect(columnNode.children[0]).toMatchObject({ id: 'l1', tabs: ['diff'], activeTabId: 'diff' });
    expect(columnNode.children[1]).toMatchObject({ id: 'l2', tabs: ['git', 'file:a'], activeTabId: 'git' });
  });

  test('a tab already in its target leaf activates without duplicating', () => {
    const tree = split('s1', 'row', [CHAT_NODE, leaf('l1', ['git', 'diff'], 'git')], [0.7, 0.3]);
    const moved = moveTabToLeaf(tree, 'git', 'l1');
    expect(asSplit(moved).children[1]).toMatchObject({ tabs: ['git', 'diff'], activeTabId: 'git' });
  });

  test('activate and drop touch only the leaf that holds the tab', () => {
    const tree = split('s1', 'row', [CHAT_NODE, leaf('l1', ['git', 'diff'], 'git')], [0.7, 0.3]);
    const active = activateTab(tree, 'diff');
    expect(asSplit(active).children[1]).toMatchObject({ activeTabId: 'diff' });

    const dropped = dropTab(active, 'diff');
    expect(asSplit(dropped).children[1]).toMatchObject({ tabs: ['git'], activeTabId: 'git' });
  });

  test('a divider drag moves share between its two children only', () => {
    const tree = split('s1', 'row', [CHAT_NODE, leaf('l1', ['git']), leaf('l2', ['diff'])], [0.5, 0.25, 0.25]);
    const balanced = balanceSplitAt(tree, 's1', 1, 2, 0.6);
    const fractions = asSplit(balanced).fractions;
    expect(fractions[0]).toBe(0.5);
    expect(Math.abs(fractions[1] + fractions[2] - 0.5) < 1e-9).toBe(true);
    expect(fractions[2]).toBe(0.3);
    // The pair never lets either side fall under the minimum share.
    const pinned = balanceSplitAt(tree, 's1', 1, 2, 0.999);
    expect(asSplit(pinned).fractions[2]).toBeLessThan(0.45 + 1e-9);
  });

  test('an opened surface lands by mode, first-filled, or fresh split, in that order', () => {
    const panelTabs = [
      { id: 'git', mode: 'git' },
      { id: 'diff:a', mode: 'diff' },
      { id: 'terminal', mode: 'terminal' },
    ];
    const twoLeaves = split('s1', 'row',
      [CHAT_NODE, split('s2', 'column', [leaf('l1', ['git']), leaf('l2', ['diff:a'])], [0.5, 0.5])],
      [0.7, 0.3]);

    // A second diff lands beside the leaf that already shows one.
    const modeMatch = openSurfaceInTree(twoLeaves, panelTabs, 'diff:b', 'diff');
    expect(modeMatch.leafId).toBe('l2');
    expect(asSplit(asSplit(modeMatch.tree).children[1]).children[1])
      .toMatchObject({ tabs: ['diff:a', 'diff:b'], activeTabId: 'diff:b' });

    // A terminal has no leaf yet: the first filled leaf takes it.
    const firstFilled = openSurfaceInTree(twoLeaves, panelTabs, 'terminal', 'terminal');
    expect(firstFilled.leafId).toBe('l1');

    // Reopening a placed tab just activates it in place.
    const again = openSurfaceInTree(modeMatch.tree, panelTabs, 'diff:a', 'diff');
    expect(again.leafId).toBe('l2');
    expect(asSplit(asSplit(again.tree).children[1]).children[1])
      .toMatchObject({ tabs: ['diff:a', 'diff:b'], activeTabId: 'diff:a' });
  });

  test('an opened surface claims the first empty leaf, it never makes a second one', () => {
    const lonely = split('s1', 'row', [CHAT_NODE, leaf('l1', [])], [0.7, 0.3]);
    const placed = openSurfaceInTree(lonely, [{ id: 'git', mode: 'git' }], 'git', 'git');
    expect(placed.leafId).toBe('l1');
    expect(asSplit(placed.tree).children[1]).toMatchObject({ tabs: ['git'], activeTabId: 'git' });
  });

  test('a layout with no leaf at all splits the chat like the old right panel', () => {
    const placed = openSurfaceInTree(CHAT_NODE, [], 'git', 'git');
    expect(placed.leafId.startsWith('leaf-')).toBe(true);
    const row = asSplit(placed.tree);
    expect(row.axis).toBe('row');
    expect(row.fractions).toEqual([0.7, 0.3]);
    expect(row.children[0]).toBe(CHAT_NODE);
    expect(row.children[1]).toMatchObject({ tabs: ['git'], activeTabId: 'git' });
  });

  test('renamed file ids follow their tabs across the tree', () => {
    const tree = split('s1', 'row',
      [CHAT_NODE, split('s2', 'column', [leaf('l1', ['file:a', 'git'], 'file:a'), leaf('l2', [])], [0.5, 0.5])],
      [0.7, 0.3]);
    const renamed = new Map([['file:a', 'file:b']]);
    const moved = renameTabsInTree(tree, renamed);
    const columnNode = asSplit(asSplit(moved).children[1]);
    expect(columnNode.children[0]).toMatchObject({ tabs: ['file:b', 'git'], activeTabId: 'file:b' });
    // Leaves untouched by the rename keep their identity.
    expect(columnNode.children[1]).toBe(asSplit(asSplit(tree).children[1]).children[1]);
    expect(renameTabsInTree(tree, new Map())).toBe(tree);
  });

  test('the legacy three-zone state reads into its tree shape', () => {
    const panel = {
      isOpen: true,
      activeTabId: 'git',
      tabs: [tab('git', 'git'), tab('file:a', 'file'), tab('terminal', 'terminal')],
      zones: {
        left: { isOpen: true, activeTabId: 'file:a' },
        bottom: { isOpen: true, activeTabId: 'terminal' },
      },
    };
    const tree = treeFromZonedPanel(panel, { file: 'left', terminal: 'bottom' });
    const columnNode = asSplit(tree);
    expect(columnNode.axis).toBe('column');
    const row = asSplit(columnNode.children[0]);
    expect(row.axis).toBe('row');
    expect(row.children.map((child) => child.kind === 'leaf' && child.tabs)).toEqual([['file:a'], false, ['git']]);
    expect(row.children[1]).toBe(CHAT_NODE);
    expect(columnNode.children[1]).toMatchObject({ tabs: ['terminal'], activeTabId: 'terminal' });
  });

  test('closed legacy zones leave no leaves, but the chat keeps its side', () => {
    const panel = {
      isOpen: false,
      activeTabId: 'git',
      tabs: [tab('git', 'git')],
      zones: {
        left: { isOpen: false, activeTabId: null },
        bottom: { isOpen: false, activeTabId: null },
      },
    };
    expect(treeFromZonedPanel(panel, {})).toBe(CHAT_NODE);
  });

  test('the right zone alone becomes the classic side-by-side layout', () => {
    const panel = {
      isOpen: true,
      activeTabId: 'git',
      tabs: [tab('git', 'git')],
      zones: {
        left: { isOpen: false, activeTabId: null },
        bottom: { isOpen: false, activeTabId: null },
      },
    };
    const tree = treeFromZonedPanel(panel, {});
    const row = asSplit(tree);
    expect(row.fractions[0]).toBeGreaterThan(row.fractions[1]);
    expect(row.children[0]).toBe(CHAT_NODE);
    expect(row.children[1]).toMatchObject({ tabs: ['git'] });
  });

  test('leaves and helpers agree on what the layout holds', () => {
    const tree = split('s1', 'row', [CHAT_NODE, leaf('l1', ['git'])], [0.7, 0.3]);
    expect(leavesOf(tree).map((node) => node.id)).toEqual(['l1']);
    expect(findLeaf(tree, 'l1')?.activeTabId).toBe('git');
    expect(findLeaf(tree, 'gone')).toBeNull();
  });
});
