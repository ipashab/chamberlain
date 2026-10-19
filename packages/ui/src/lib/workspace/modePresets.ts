import {
  CHAT_NODE,
  findLeaf,
  splitChat,
  splitLeaf,
  type SplitAxis,
  type WorkspaceTree,
} from './layoutTree';
import type { ContextPanelMode } from '@/lib/surfaces/modes';

/**
 * Workspace modes: named per-project presets over the region tree. The
 * active mode's tree is the directory's ordinary `layout`; the other modes'
 * saved trees wait in `modeLayouts`. No mode owns tabs — a preset only fixes
 * region shape, and surfaces move into it through the same open paths a
 * manual split uses.
 *
 * - `chat`   — the layout the app has always had: chat central.
 * - `debug`  — editor over the debug panel, chat as the right column.
 * - `board`  — the issues-and-PRs board beside its detail region, chat as
 *              the right column.
 */
export const WORKSPACE_MODES = ['chat', 'debug', 'board'] as const;
export type WorkspaceMode = (typeof WORKSPACE_MODES)[number];

const WORKSPACE_MODE_VALUES = new Set<string>(WORKSPACE_MODES);

export const isWorkspaceMode = (value: string): value is WorkspaceMode =>
  WORKSPACE_MODE_VALUES.has(value);

export const DEFAULT_WORKSPACE_MODE: WorkspaceMode = 'chat';

/** Saved region trees per mode; the active mode's tree is `layout` itself. */
export type WorkspaceModeLayouts = Partial<Record<WorkspaceMode, WorkspaceTree>>;

/**
 * The chat column of the aux modes, as a share of the whole row. Narrow
 * enough that a 1440px window still leaves the working regions a full
 * screen's worth of editor and board.
 */
const CHAT_COLUMN_FRACTION = 0.25;

// Stable leaf ids, so the store can open surfaces into a preset's named
// regions and route the board mode's detail tabs without remembering ids.
export const DEBUG_EDITOR_LEAF_ID = 'leaf-mode-debug-editor';
export const DEBUG_PANEL_LEAF_ID = 'leaf-mode-debug-panel';
export const BOARD_LIST_LEAF_ID = 'leaf-mode-board-list';
export const BOARD_DETAIL_LEAF_ID = 'leaf-mode-board-detail';

/** What applying a preset opens: surfaces placed into their preset regions. */
interface WorkspaceModePreset {
  tree: WorkspaceTree;
  /** Surfaces to open into their leaves once the tree is in place. */
  opens: ReadonlyArray<{ mode: 'file' | 'debug' | 'board'; leafId: string }>;
}

/**
 * The debug preset: the editor (with its docked file tree) over the debug
 * panel, the chat as a narrow column on the end. The editor leaf starts
 * empty — an empty editor still shows the project's file tree, and a file
 * opened anywhere lands in this region while the mode is on.
 */
export const debugModePreset = (): WorkspaceModePreset => {
  // Chat last: the working area takes the start of the row, and the editor
  // leaf is that whole area until the debug panel splits underneath it.
  const column = splitChat(CHAT_NODE, 'row', {
    newLeafId: DEBUG_EDITOR_LEAF_ID,
    fraction: 1 - CHAT_COLUMN_FRACTION,
    chatLast: true,
  });
  const split = splitLeaf(column.tree, DEBUG_EDITOR_LEAF_ID, 'column', {
    newLeafId: DEBUG_PANEL_LEAF_ID,
    fraction: 0.42,
  });
  // A chat alone has no leaf to split: defensive, keep a flat preset instead
  // of crashing a mode switch on an impossible branch.
  if (!split) return { tree: column.tree, opens: [] };
  // splitLeaf puts the new leaf last: [editor, debug-at-42%].
  return {
    tree: split.tree,
    opens: [
      { mode: 'file', leafId: DEBUG_EDITOR_LEAF_ID },
      { mode: 'debug', leafId: DEBUG_PANEL_LEAF_ID },
    ],
  };
};

/**
 * The board preset: the issues-and-PRs board with a detail region for the
 * Tracker's item cards (and diffs), the chat as a narrow column on the end.
 */
export const boardModePreset = (): WorkspaceModePreset => {
  // Chat last; the working area takes the start of the row.
  const row = splitChat(CHAT_NODE, 'row', {
    newLeafId: BOARD_LIST_LEAF_ID,
    fraction: 1 - CHAT_COLUMN_FRACTION,
    chatLast: true,
  });
  const split = splitLeaf(row.tree, BOARD_LIST_LEAF_ID, 'row', {
    newLeafId: BOARD_DETAIL_LEAF_ID,
    fraction: 0.42,
  });
  // A chat alone has no leaf to split: defensive, keep a flat preset instead
  // of crashing a mode switch on an impossible branch.
  if (!split) return { tree: row.tree, opens: [] };
  // Board list first (~44%), detail beside it (~32%), chat on the end.
  return {
    tree: split.tree,
    opens: [{ mode: 'board', leafId: BOARD_LIST_LEAF_ID }],
  };
};

/** The preset a mode enters with; 'chat' enters with the chat alone. */
export const workspaceModePreset = (mode: WorkspaceMode): WorkspaceModePreset => {
  if (mode === 'debug') return debugModePreset();
  if (mode === 'board') return boardModePreset();
  return { tree: CHAT_NODE, opens: [] };
};

/** A named region a mode is answerable for, and how to rebuild it in place. */
interface PresetRegion {
  leafId: string;
  /** The sibling named leaf whose region the rebuilt one splits off from. */
  anchorLeafId: string;
  axis: SplitAxis;
  fraction: number;
  /** The rebuilt region sits above/left of the anchor rather than after it. */
  newLeafFirst?: boolean;
}

/**
 * The regions a mode shows whatever the saved tree looks like: the debug
 * editor above the debug panel, the board's detail beside the board. A user
 * who closed one of them while working gets it back on the next entry, since
 * a mode without its region is not the arrangement its name promises.
 */
const PRESET_REGIONS = {
  // The chat keeps no region's shape: any tree is the arrangement its user
  // left, and entering it rebuilds nothing.
  chat: [],
  debug: [{
    leafId: DEBUG_EDITOR_LEAF_ID,
    anchorLeafId: DEBUG_PANEL_LEAF_ID,
    axis: 'column',
    fraction: 0.58,
    newLeafFirst: true,
  }],
  board: [{
    leafId: BOARD_DETAIL_LEAF_ID,
    anchorLeafId: BOARD_LIST_LEAF_ID,
    axis: 'row',
    fraction: 0.42,
    newLeafFirst: false,
  }],
} satisfies Record<WorkspaceMode, ReadonlyArray<PresetRegion>>;

/**
 * Rebuilds the preset regions the incoming tree is missing, splitting each
 * one off its anchor leaf. Everything else in the tree — the other regions'
 * sizes, the chat column, unnamed leaves the user made — stays as it is. A
 * region whose anchor is gone too is left alone: with nothing of the mode's
 * shape left, the saved tree is the user's own arrangement, not a broken one.
 */
export const restorePresetRegions = (mode: WorkspaceMode, tree: WorkspaceTree): WorkspaceTree => {
  let next = tree;
  const regions: ReadonlyArray<PresetRegion> = PRESET_REGIONS[mode];
  for (const region of regions) {
    if (findLeaf(next, region.leafId) || !findLeaf(next, region.anchorLeafId)) continue;
    const split = splitLeaf(next, region.anchorLeafId, region.axis, {
      newLeafId: region.leafId,
      fraction: region.fraction,
      newLeafFirst: region.newLeafFirst,
    });
    if (split) next = split.tree;
  }
  return next;
};

/** Placement while the board mode is on: the Tracker, diffs and walkthroughs
 * open beside the board, not stacked on its own region. */
export const BOARD_DETAIL_MODES: ReadonlySet<ContextPanelMode> = new Set(['pr', 'diff', 'walkthrough']);

/**
 * Surfaces the debug mode's editor leaf owns: opening one while the mode is
 * on routes into `DEBUG_EDITOR_LEAF_ID`, so picking a file cannot drop it
 * into the debugger's leaf and leave the editor region empty.
 */
export const DEBUG_EDITOR_MODES: ReadonlySet<ContextPanelMode> = new Set(['file', 'diff']);
