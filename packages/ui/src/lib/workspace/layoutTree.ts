import { z } from 'zod';

/**
 * The workspace layout as a tree. The three fixed zones of the old model
 * could say "beside the chat" and "under the chat"; this tree says it the
 * way tmux does: every split divides one region in two, and any region can
 * split again. Node shapes:
 *
 * - `chat`   — the session's main chat, exactly one per tree. It is a
 *              position in the layout like any other, so a split can put
 *              surfaces to either side of it and above or below it.
 * - `leaf`   — a stack of surface tabs. Tabs themselves live in the shared
 *              per-project panel tab list; a leaf only holds tab ids, so the
 *              same tab can never sit in two leaves.
 * - `split`  — a row or column of regions with size fractions.
 *
 * `row` children sit side by side with vertical dividers; `column` children
 * stack with horizontal ones. Sizes are fractions of the split's own space,
 * one per child, always summing to one.
 */

type SplitAxis = 'row' | 'column';

interface ChatNode {
  kind: 'chat';
}

export interface LeafNode {
  kind: 'leaf';
  id: string;
  tabs: readonly string[];
  activeTabId: string | null;
}

interface SplitNode {
  kind: 'split';
  id: string;
  axis: SplitAxis;
  fractions: readonly number[];
  children: readonly WorkspaceNode[];
}

type WorkspaceNode = ChatNode | LeafNode | SplitNode;
export type WorkspaceTree = WorkspaceNode;

/** The layout a project starts with: just the chat. */
export const CHAT_NODE: ChatNode = { kind: 'chat' };

/**
 * A leaf with no tabs still renders, as a drop target with a close action,
 * because an explicit split the user made survives a reload. The chat is
 * never empty, so a tree always shows something.
 */
const isLeaf = (node: WorkspaceNode): node is LeafNode => node.kind === 'leaf';
const isSplit = (node: WorkspaceNode): node is SplitNode => node.kind === 'split';

/** How small one region may get inside its split, as a share of the split. */
const MIN_FRACTION = 0.1;

const newId = (prefix: string): string => `${prefix}-${crypto.randomUUID()}`;

const clampFraction = (value: number): number =>
  Number.isFinite(value) ? Math.min(1 - MIN_FRACTION, Math.max(MIN_FRACTION, value)) : 0.5;

const makeSplit = (axis: SplitAxis, children: readonly WorkspaceNode[], fractions: readonly number[]): SplitNode => ({
  kind: 'split',
  id: newId('split'),
  axis,
  fractions: normalize(fractions, children.length),
  children,
});

const chatNodeSchema = z.object({ kind: z.literal('chat') });

const leafNodeSchema = z.object({
  kind: z.literal('leaf'),
  id: z.string().min(1),
  tabs: z.array(z.string()),
  activeTabId: z.string().nullable().catch(null),
});

const workspaceNodeSchema: z.ZodType<WorkspaceNode> = z.lazy(() =>
  z.union([
    chatNodeSchema,
    leafNodeSchema,
    z.object({
      kind: z.literal('split'),
      id: z.string().min(1),
      axis: z.enum(['row', 'column']),
      fractions: z.array(z.number()),
      // SAFETY: zod cannot type this recursive member of the lazy union;
      // sanitizeTree re-checks every parsed node before the tree renders.
      children: z.array(workspaceNodeSchema),
    }) as never,
  ]),
);

/**
 * Reads the stored layout. Any node form parses; hopeless data reads as the
 * chat alone. sanitizeTree repairs fractions and dangling active tabs on
 * the way in, so a corrupted region cannot take the layout down.
 */
export const storedTreeSchema = workspaceNodeSchema
  .nullable()
  .optional()
  .catch(null)
  .transform((parsed) => (parsed ? sanitizeTree(parsed, new Set()) : CHAT_NODE));

/**
 * Repairs a tree in one pass: splits with one child collapse, fractions
 * match children and sum to one, active tabs point at tabs the leaf really
 * holds. Called after every operation. `presentTabs` filters tab ids
 * against the live tab list; an empty set means trust every tab.
 */
export const sanitizeTree = (tree: WorkspaceTree, presentTabs: ReadonlySet<string>): WorkspaceTree => repair(tree, presentTabs);

const repair = (node: WorkspaceNode, presentTabs: ReadonlySet<string>): WorkspaceTree => {
  if (node.kind === 'chat') return node;
  if (node.kind === 'leaf') {
    const tabs = presentTabs.size === 0 ? [...node.tabs] : node.tabs.filter((id) => presentTabs.has(id));
    const activeTabId = tabs.includes(node.activeTabId ?? '') ? node.activeTabId : tabs.at(-1) ?? null;
    return tabs.length === node.tabs.length && activeTabId === node.activeTabId
      ? node
      : { ...node, tabs, activeTabId };
  }
  const children = node.children.map((child) => repair(child, presentTabs));
  if (children.length === 1) return children[0];
  if (children.length === 0) return CHAT_NODE;
  const childChanged = children.some((child, index) => child !== node.children[index]);
  if (!childChanged && node.fractions.length === children.length && fractionsSane(node.fractions)) {
    return node;
  }
  return { ...node, children, fractions: normalize(node.fractions, children.length) };
};

const fractionsSane = (fractions: readonly number[]): boolean => {
  if (fractions.length === 0) return false;
  const total = fractions.reduce((sum, value) => sum + value, 0);
  return fractions.every((value) => Number.isFinite(value) && value > 0) && Math.abs(total - 1) < 1e-6;
};

/**
 * One fraction per child: fractions that already fit are renormalized to
 * sum one, anything else divides the space evenly.
 */
const normalize = (fractions: readonly number[], childCount: number): number[] => {
  if (childCount === 0) return [];
  const usable = fractions.filter((value) => Number.isFinite(value) && value > 0);
  if (usable.length === childCount) {
    const total = usable.reduce((sum, value) => sum + value, 0);
    if (total > 0) return usable.map((value) => value / total);
  }
  return Array.from({ length: childCount }, () => 1 / childCount);
};

const containsChat = (node: WorkspaceNode): boolean =>
  node.kind === 'chat' || (node.kind === 'split' && node.children.some(containsChat));

/**
 * A tree without its chat is invalid. This wraps whatever is there in a row
 * split with a fresh chat at the head, which is where every legacy layout
 * left room for the main chat.
 */
export const ensureChat = (tree: WorkspaceTree): WorkspaceTree =>
  containsChat(tree) ? tree : makeSplit('row', [CHAT_NODE, tree], [0.7, 0.3]);

/**
 * Every node in traversal order.
 */
const walkTree = (tree: WorkspaceTree): WorkspaceNode[] => {
  const out: WorkspaceNode[] = [];
  const visit = (node: WorkspaceNode) => {
    out.push(node);
    if (isSplit(node)) node.children.forEach(visit);
  };
  visit(tree);
  return out;
};

export const findLeaf = (tree: WorkspaceTree, leafId: string): LeafNode | null =>
  walkTree(tree).find((node): node is LeafNode => isLeaf(node) && node.id === leafId) ?? null;

/** Every leaf in layout order. */
export const leavesOf = (tree: WorkspaceTree): LeafNode[] =>
  walkTree(tree).filter(isLeaf);

/** What opening a surface leaves behind: the layout and the leaf that took it. */
interface OpenOutcome {
  tree: WorkspaceTree;
  leafId: string;
}

/**
 * Where a newly opened surface lands, applied: a tab goes to the leaf that
 * already shows its surface, else the first leaf with tabs, else the first
 * empty leaf waiting for something to open in it. A layout with no leaf at
 * all splits the chat the way the old right panel did, chat first. A tab
 * that already sits in its target leaf just activates, so re-opening is
 * idempotent.
 */
export const openSurfaceInTree = (
  tree: WorkspaceTree,
  panelTabs: ReadonlyArray<{ id: string; mode: string }>,
  tabId: string,
  mode: string,
): OpenOutcome => {
  const modeTabIds = new Set(panelTabs.filter((tab) => tab.mode === mode).map((tab) => tab.id));
  const leaves = leavesOf(tree);
  const target = leaves.find((leaf) => leaf.tabs.some((id) => modeTabIds.has(id)))
    ?? leaves.find((leaf) => leaf.tabs.length > 0)
    ?? leaves[0];
  if (target) {
    return { tree: moveTabToLeaf(tree, tabId, target.id), leafId: target.id };
  }
  const split = splitChat(tree, 'row', { fraction: 0.3 });
  return { tree: moveTabToLeaf(split.tree, tabId, split.newLeaf.id), leafId: split.newLeaf.id };
};

/**
 * File moves rename tab ids; the leaves follow. `renamed` maps each old id
 * to its new one; tabs the map does not name stay put.
 */
export const renameTabsInTree = (tree: WorkspaceTree, renamed: ReadonlyMap<string, string>): WorkspaceTree => {
  if (renamed.size === 0) return tree;
  const map = (node: WorkspaceNode): WorkspaceNode => {
    if (isLeaf(node)) {
      const renamedHere = node.tabs.some((id) => renamed.has(id))
        || (node.activeTabId !== null && renamed.has(node.activeTabId));
      if (!renamedHere) return node;
      const tabs = node.tabs.map((id) => renamed.get(id) ?? id);
      const activeTabId = node.activeTabId ? (renamed.get(node.activeTabId) ?? node.activeTabId) : null;
      return { ...node, tabs, activeTabId };
    }
    if (!isSplit(node)) return node;
    const children = node.children.map(map);
    return children.some((child, index) => child !== node.children[index]) ? { ...node, children } : node;
  };
  return map(tree);
};

/** What a split leaves behind: the layout and the leaf it opened. */
interface SplitOutcome {
  tree: WorkspaceTree;
  newLeaf: LeafNode;
}

/**
 * Splits a leaf's region in two. The existing leaf keeps its tabs on its
 * side of the divider; a fresh empty leaf takes the other side.
 */
export const splitLeaf = (
  tree: WorkspaceTree,
  leafId: string,
  axis: SplitAxis,
  options: { newLeafId?: string; fraction?: number } = {},
): SplitOutcome | null => {
  const newLeaf: LeafNode = { kind: 'leaf', id: options.newLeafId ?? newId('leaf'), tabs: [], activeTabId: null };
  const splitAt = (node: WorkspaceNode): WorkspaceNode => {
    if (isLeaf(node) && node.id === leafId) {
      return makeSplit(axis, [node, newLeaf], [1 - clampFraction(options.fraction ?? 0.5), clampFraction(options.fraction ?? 0.5)]);
    }
    if (!isSplit(node)) return node;
    const children = node.children.map(splitAt);
    return children.some((child, index) => child !== node.children[index]) ? { ...node, children } : node;
  };
  const next = splitAt(tree);
  return next === tree ? null : { tree: next, newLeaf };
};

/**
 * Splits the chat's region: the chat keeps its side, a fresh empty leaf
 * takes the other. Replaces the chat in place, so other regions keep
 * their sizes and positions.
 */
export const splitChat = (
  tree: WorkspaceTree,
  axis: SplitAxis,
  options: { newLeafId?: string; fraction?: number } = {},
): SplitOutcome => {
  const fraction = clampFraction(options.fraction ?? 0.5);
  const newLeaf: LeafNode = { kind: 'leaf', id: options.newLeafId ?? newId('leaf'), tabs: [], activeTabId: null };
  const wrapper = makeSplit(axis, [CHAT_NODE, newLeaf], [1 - fraction, fraction]);
  const splitAt = (node: WorkspaceNode): WorkspaceNode =>
    node.kind === 'chat' ? wrapper : isSplit(node) ? { ...node, children: node.children.map(splitAt) } : node;
  return { tree: splitAt(tree), newLeaf };
};

/**
 * Removes a leaf. Splits whose children fall to one collapse into that
 * child, so closing a leaf closes its divider too, and a tree that loses
 * everything reads as the chat alone.
 */
export const closeLeaf = (tree: WorkspaceTree, leafId: string): WorkspaceTree => {
  if (isSplit(tree)) {
    const kept = tree.children.filter((child) => !(isLeaf(child) && child.id === leafId));
    if (kept.length === tree.children.length) {
      return { ...tree, children: tree.children.map((child) => closeLeaf(child, leafId)) };
    }
    if (kept.length === 0) return CHAT_NODE;
    if (kept.length === 1) return kept[0];
    return { ...tree, children: kept, fractions: normalize(tree.fractions, kept.length) };
  }
  if (isLeaf(tree) && tree.id === leafId) return CHAT_NODE;
  return tree;
};

/**
 * Moves one tab between leaves. The tab leaves its old leaf entirely and
 * the target activates what moved. A tab already in the target stays put
 * and just activates, at `index` when given.
 */
export const moveTabToLeaf = (
  tree: WorkspaceTree,
  tabId: string,
  toLeafId: string,
  options: { index?: number } = {},
): WorkspaceTree => {
  const map = (node: WorkspaceNode): WorkspaceNode => {
    if (isLeaf(node)) {
      if (node.id === toLeafId) {
        // Already here: activate where it sits, at `index` only when given.
        if (node.tabs.includes(tabId) && options.index == null) {
          return { ...node, activeTabId: tabId };
        }
        const without = node.tabs.filter((id) => id !== tabId);
        const at = options.index == null ? without.length : Math.min(Math.max(options.index, 0), without.length);
        return { ...node, tabs: [...without.slice(0, at), tabId, ...without.slice(at)], activeTabId: tabId };
      }
      if (!node.tabs.includes(tabId)) return node;
      const tabs = node.tabs.filter((id) => id !== tabId);
      return { ...node, tabs, activeTabId: node.activeTabId === tabId ? (tabs.at(-1) ?? null) : node.activeTabId };
    }
    return isSplit(node) ? { ...node, children: node.children.map(map) } : node;
  };
  return map(tree);
};

/** Activates a tab inside its leaf. */
export const activateTab = (tree: WorkspaceTree, tabId: string): WorkspaceTree => {
  const map = (node: WorkspaceNode): WorkspaceNode =>
    isLeaf(node) && node.tabs.includes(tabId)
      ? { ...node, activeTabId: tabId }
      : isSplit(node) ? { ...node, children: node.children.map(map) } : node;
  return map(tree);
};

/** Drops a closed tab out of its leaf. */
export const dropTab = (tree: WorkspaceTree, tabId: string): WorkspaceTree => {
  const map = (node: WorkspaceNode): WorkspaceNode => {
    if (isLeaf(node)) {
      if (!node.tabs.includes(tabId)) return node;
      const tabs = node.tabs.filter((id) => id !== tabId);
      return { ...node, tabs, activeTabId: node.activeTabId === tabId ? (tabs.at(-1) ?? null) : node.activeTabId };
    }
    return isSplit(node) ? { ...node, children: node.children.map(map) } : node;
  };
  return map(tree);
};

/**
 * A divider drag ends here. `leadingIndex` and `trailingIndex` name the two
 * children the divider sits between; `trailingShare` is the share of the
 * pair the trailing child should take. The rest of the split is untouched.
 */
export const balanceSplitAt = (
  tree: WorkspaceTree,
  splitId: string,
  leadingIndex: number,
  trailingIndex: number,
  trailingShare: number,
): WorkspaceTree => {
  const map = (node: WorkspaceNode): WorkspaceNode => {
    if (!isSplit(node) || node.id !== splitId) {
      return isSplit(node) ? { ...node, children: node.children.map(map) } : node;
    }
    if (trailingIndex !== leadingIndex + 1 || trailingIndex >= node.fractions.length) return node;
    const pair = node.fractions[leadingIndex] + node.fractions[trailingIndex];
    if (pair <= 0) return node;
    const fractions = [...node.fractions];
    fractions[trailingIndex] = pair * clampFraction(trailingShare);
    fractions[leadingIndex] = pair - fractions[trailingIndex];
    return { ...node, fractions };
  };
  return map(tree);
};

/**
 * Reads the old three-zone state into a tree. Open zones become leaves
 * joined by splits in their old positions; a tab belongs to whichever zone
 * its surface's placement named. Closed zones' tabs stay in the shared tab
 * list and open later through the normal open path, so nothing a close
 * had hidden pops back on upgrade.
 */
export const treeFromZonedPanel = (
  panel: {
    isOpen: boolean;
    activeTabId: string | null;
    tabs: ReadonlyArray<{ id: string; mode: string }>;
    zones: Readonly<Record<'left' | 'bottom', { isOpen: boolean; activeTabId: string | null }>>;
  },
  placement: Readonly<Record<string, 'left' | 'bottom'>>,
): WorkspaceTree => {
  const zoneOf = (mode: string): 'left' | 'right' | 'bottom' =>
    placement[mode] === 'left' ? 'left' : placement[mode] === 'bottom' ? 'bottom' : 'right';
  const leafOf = (zone: 'left' | 'right' | 'bottom', view: { isOpen: boolean; activeTabId: string | null }, id: string): LeafNode | null => {
    if (!view.isOpen) return null;
    const tabs = panel.tabs.filter((tab) => zoneOf(tab.mode) === zone).map((tab) => tab.id);
    if (tabs.length === 0) return null;
    return { kind: 'leaf', id, tabs, activeTabId: tabs.includes(view.activeTabId ?? '') ? view.activeTabId : tabs.at(-1) ?? null };
  };

  const left = leafOf('left', panel.zones.left, 'leaf-legacy-left');
  const right = leafOf('right', { isOpen: panel.isOpen, activeTabId: panel.activeTabId }, 'leaf-legacy-right');
  const bottom = leafOf('bottom', panel.zones.bottom, 'leaf-legacy-bottom');

  let row: WorkspaceTree = CHAT_NODE;
  if (left && right) row = makeSplit('row', [left, CHAT_NODE, right], [0.3, 0.4, 0.3]);
  else if (left) row = makeSplit('row', [left, CHAT_NODE], [0.3, 0.7]);
  else if (right) row = makeSplit('row', [CHAT_NODE, right], [0.7, 0.3]);

  return bottom ? makeSplit('column', [row, bottom], [0.7, 0.3]) : row;
};
