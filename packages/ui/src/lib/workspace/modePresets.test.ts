import { describe, expect, test } from 'bun:test';

import { CHAT_NODE, leavesOf, findLeaf, splitChat } from './layoutTree';
import {
  BOARD_DETAIL_LEAF_ID,
  BOARD_LIST_LEAF_ID,
  DEBUG_EDITOR_LEAF_ID,
  DEBUG_PANEL_LEAF_ID,
  debugModePreset,
  boardModePreset,
  isWorkspaceMode,
  restorePresetRegions,
  WORKSPACE_MODES,
  workspaceModePreset,
} from './modePresets';

const isSplit = (tree: ReturnType<typeof workspaceModePreset>['tree']) =>
  tree.kind === 'split' ? tree : null;

describe('workspace mode presets', () => {
  test('mode values are closed and validated', () => {
    expect([...WORKSPACE_MODES]).toEqual(['chat', 'debug', 'board']);
    expect(isWorkspaceMode('chat')).toBe(true);
    expect(isWorkspaceMode('overview')).toBe(false);
  });

  test('chat enters with the chat alone', () => {
    const preset = workspaceModePreset('chat');
    expect(preset.tree).toBe(CHAT_NODE);
    expect(preset.opens).toEqual([]);
  });

  test('debug docks the chat as the right column, editor above the panel', () => {
    const { tree, opens } = debugModePreset();
    const row = isSplit(tree);
    expect(row?.axis).toBe('row');
    // Chat last: the working area takes the start of the row.
    expect(row?.children.at(-1)?.kind).toBe('chat');

    const editor = findLeaf(tree, DEBUG_EDITOR_LEAF_ID);
    const panel = findLeaf(tree, DEBUG_PANEL_LEAF_ID);
    expect(editor).not.toBeNull();
    expect(panel).not.toBeNull();
    // The debug panel sits below the editor in the column's tail.
    const splitColumn = row?.children.find((child) => child.kind === 'split' && child.axis === 'column');
    expect(splitColumn && 'children' in splitColumn ? splitColumn.children.at(-1) : null).toBe(panel);
    expect(opens).toEqual([
      { mode: 'file', leafId: DEBUG_EDITOR_LEAF_ID },
      { mode: 'debug', leafId: DEBUG_PANEL_LEAF_ID },
    ]);
  });

  test('board puts the list first, the detail region beside it, chat last', () => {
    const { tree, opens } = boardModePreset();
    const row = isSplit(tree);
    expect(row?.axis).toBe('row');
    expect(row?.children.at(-1)?.kind).toBe('chat');

    const list = findLeaf(tree, BOARD_LIST_LEAF_ID);
    const detail = findLeaf(tree, BOARD_DETAIL_LEAF_ID);
    expect(list).not.toBeNull();
    expect(detail).not.toBeNull();
    const detailIndex = leavesOf(tree).findIndex((leaf) => leaf.id === BOARD_DETAIL_LEAF_ID);
    const listIndex = leavesOf(tree).findIndex((leaf) => leaf.id === BOARD_LIST_LEAF_ID);
    expect(listIndex).toBeLessThan(detailIndex);
    expect(opens).toEqual([{ mode: 'board', leafId: BOARD_LIST_LEAF_ID }]);
  });

  test('each call returns a fresh tree', () => {
    const first = debugModePreset().tree;
    const second = debugModePreset().tree;
    expect(first).not.toBe(second);
  });

  test('restorePresetRegions rebuilds a lost debug editor above its panel', () => {
    // The saved tree a user is left with after closing the editor region:
    // the panel beside the chat, nothing else.
    const saved = splitChat(CHAT_NODE, 'row', {
      newLeafId: DEBUG_PANEL_LEAF_ID,
      fraction: 0.61,
      chatLast: true,
    }).tree;
    const restored = restorePresetRegions('debug', saved);

    const editor = findLeaf(restored, DEBUG_EDITOR_LEAF_ID);
    expect(editor).not.toBeNull();
    // Rebuilt above the panel, with the chat keeping its place as the
    // row's other side.
    const leaves = leavesOf(restored);
    const editorIndex = leaves.findIndex((node) => node.id === DEBUG_EDITOR_LEAF_ID);
    const panelIndex = leaves.findIndex((node) => node.id === DEBUG_PANEL_LEAF_ID);
    expect(leaves.length).toBe(2);
    expect(editorIndex).toBeLessThan(panelIndex);
    const rowOf = isSplit(restored);
    expect(rowOf?.children.at(-1)).toBe(CHAT_NODE);
  });

  test('restorePresetRegions touches nothing when its regions are in place', () => {
    const preset = debugModePreset().tree;
    expect(restorePresetRegions('debug', preset)).toBe(preset);
  });
});
