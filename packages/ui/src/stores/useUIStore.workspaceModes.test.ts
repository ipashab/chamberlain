import { beforeEach, describe, expect, test } from 'bun:test';

import { CHAT_NODE, findLeaf } from '../lib/workspace/layoutTree';
import {
  BOARD_DETAIL_LEAF_ID,
  BOARD_LIST_LEAF_ID,
  DEBUG_EDITOR_LEAF_ID,
  DEBUG_PANEL_LEAF_ID,
} from '../lib/workspace/modePresets';
import { useUIStore } from './useUIStore';

const DIRECTORY = '/repo';

const panel = () => useUIStore.getState().contextPanelByDirectory[DIRECTORY];
const modeTabs = (mode: string) => (panel()?.tabs ?? []).filter((tab) => tab.mode === mode);

beforeEach(() => {
  useUIStore.setState({
    contextPanelByDirectory: {},
    workspaceModeOffer: null,
    workspaceModeOfferDismissed: [],
    contextRailOrder: [],
    contextEditorTreeVisible: true,
  });
});

describe('useUIStore workspace modes', () => {
  test('a first switch to debug applies its preset with surfaces in place', () => {
    useUIStore.getState().switchWorkspaceMode(DIRECTORY, 'debug');

    const state = panel();
    expect(state?.workspaceMode).toBe('debug');
    // Preset regions exist and hold their surfaces.
    expect(findLeaf(state?.layout ?? CHAT_NODE, DEBUG_EDITOR_LEAF_ID)).not.toBeNull();
    expect(findLeaf(state?.layout ?? CHAT_NODE, DEBUG_PANEL_LEAF_ID)).not.toBeNull();
    const editorLeaf = findLeaf(state?.layout ?? CHAT_NODE, DEBUG_EDITOR_LEAF_ID);
    const panelLeaf = findLeaf(state?.layout ?? CHAT_NODE, DEBUG_PANEL_LEAF_ID);
    expect(editorLeaf?.tabs.some((id) => modeTabs('file').some((tab) => tab.id === id))).toBe(true);
    expect(panelLeaf?.tabs.some((id) => modeTabs('debug').some((tab) => tab.id === id))).toBe(true);
    // The outgoing chat tree is saved for the switch back.
    expect(state?.modeLayouts.chat).toEqual(CHAT_NODE);
  });

  test('a user arrangement survives a round trip through another mode', () => {
    const split = useUIStore.getState().splitLayoutRegion(DIRECTORY, 'chat', 'row', 0.4);
    expect(split).not.toBeNull();
    const before = panel();
    const tabsBefore = before?.tabs ?? [];

    useUIStore.getState().switchWorkspaceMode(DIRECTORY, 'board');
    useUIStore.getState().switchWorkspaceMode(DIRECTORY, 'chat');

    const after = panel();
    expect(after?.layout).toEqual(before?.layout);
    // No tab died on the way; the board preset's own surface stays in the
    // strip as a tab that survived, which is the contract.
    const idsAfter = new Set((after?.tabs ?? []).map((tab) => tab.id));
    for (const tab of tabsBefore) {
      expect(idsAfter.has(tab.id)).toBe(true);
    }
    expect(after?.workspaceMode).toBe('chat');
  });

  test('a debug editor leaf its closed tab left behind re-takes the file surface', () => {
    useUIStore.getState().switchWorkspaceMode(DIRECTORY, 'debug');
    const fileTab = modeTabs('file')[0];
    expect(fileTab).toBeDefined();
    // The user closes the files tab — here or in another mode, the strip is
    // shared — leaves, and comes back expecting the mode's own shape.
    useUIStore.getState().closeContextPanelTab(DIRECTORY, fileTab!.id);
    useUIStore.getState().switchWorkspaceMode(DIRECTORY, 'chat');
    useUIStore.getState().switchWorkspaceMode(DIRECTORY, 'debug');

    const editorLeaf = findLeaf(panel()?.layout ?? CHAT_NODE, DEBUG_EDITOR_LEAF_ID);
    expect(editorLeaf?.tabs.some((id) => modeTabs('file').some((tab) => tab.id === id))).toBe(true);
  });

  test('a debug editor region closed with its leaf is rebuilt on the next entry', () => {
    useUIStore.getState().switchWorkspaceMode(DIRECTORY, 'debug');
    const fileTab = modeTabs('file')[0];
    useUIStore.getState().closeContextPanelTab(DIRECTORY, fileTab!.id);
    // The user closes the emptied editor region itself — the saved debug
    // tree now holds only the panel and the chat, which is what used to
    // stick forever.
    useUIStore.getState().closeLayoutRegion(DIRECTORY, DEBUG_EDITOR_LEAF_ID);
    useUIStore.getState().switchWorkspaceMode(DIRECTORY, 'chat');
    useUIStore.getState().switchWorkspaceMode(DIRECTORY, 'debug');

    const layout = panel()?.layout ?? CHAT_NODE;
    const editorLeaf = findLeaf(layout, DEBUG_EDITOR_LEAF_ID);
    expect(editorLeaf?.tabs.some((id) => modeTabs('file').some((tab) => tab.id === id))).toBe(true);
    const panelLeaf = findLeaf(layout, DEBUG_PANEL_LEAF_ID);
    expect(panelLeaf?.tabs.some((id) => modeTabs('debug').some((tab) => tab.id === id))).toBe(true);
  });

  test('a board detail region closed with its leaf is rebuilt beside the board', () => {
    useUIStore.getState().switchWorkspaceMode(DIRECTORY, 'board');
    useUIStore.getState().closeLayoutRegion(DIRECTORY, BOARD_DETAIL_LEAF_ID);
    useUIStore.getState().switchWorkspaceMode(DIRECTORY, 'chat');
    useUIStore.getState().switchWorkspaceMode(DIRECTORY, 'board');

    const layout = panel()?.layout ?? CHAT_NODE;
    expect(findLeaf(layout, BOARD_LIST_LEAF_ID)).not.toBeNull();
    expect(findLeaf(layout, BOARD_DETAIL_LEAF_ID)).not.toBeNull();
  });

  test('a named leaf holding another tab stays as the user left it', () => {
    useUIStore.getState().switchWorkspaceMode(DIRECTORY, 'board');
    useUIStore.getState().switchWorkspaceMode(DIRECTORY, 'debug');
    // The board tab sits in the editor leaf and the file tab is closed: the
    // leaf holds a tab the user placed there, so re-entry leaves it alone.
    const boardTab = modeTabs('board')[0];
    const fileTab = modeTabs('file')[0];
    useUIStore.getState().moveContextPanelTabToLeaf(DIRECTORY, boardTab!.id, DEBUG_EDITOR_LEAF_ID);
    useUIStore.getState().closeContextPanelTab(DIRECTORY, fileTab!.id);
    useUIStore.getState().switchWorkspaceMode(DIRECTORY, 'chat');
    useUIStore.getState().switchWorkspaceMode(DIRECTORY, 'debug');

    const editorLeaf = findLeaf(panel()?.layout ?? CHAT_NODE, DEBUG_EDITOR_LEAF_ID);
    expect(editorLeaf?.tabs).toContain(boardTab!.id);
    expect(editorLeaf?.tabs.some((id) => modeTabs('file').some((tab) => tab.id === id))).toBe(false);
  });

  test('opening a file in debug mode keeps the editor leaf as its region', () => {
    useUIStore.getState().switchWorkspaceMode(DIRECTORY, 'debug');
    // The preset's empty editor tab is replaced by a real file open; the
    // general placement rule alone would drop the file into the debugger's
    // leaf and leave the editor region empty above it.
    useUIStore.getState().openContextFile(DIRECTORY, '/repo/src/a.ts', { preview: true });

    const editorLeaf = findLeaf(panel()?.layout ?? CHAT_NODE, DEBUG_EDITOR_LEAF_ID);
    const panelLeaf = findLeaf(panel()?.layout ?? CHAT_NODE, DEBUG_PANEL_LEAF_ID);
    const fileTab = modeTabs('file').find((tab) => tab.targetPath === '/repo/src/a.ts');
    expect(fileTab).toBeDefined();
    expect(editorLeaf?.tabs).toContain(fileTab!.id);
    expect(panelLeaf?.tabs).not.toContain(fileTab!.id);
  });

  test('entering debug opens the file tree even with the list collapsed', () => {
    // A file tab already open with the docked tree collapsed: entering the
    // mode only moves that tab, and the mode's editor region is asked for
    // with its list.
    useUIStore.getState().openContextPanelTab(DIRECTORY, { mode: 'file' });
    useUIStore.setState({ contextEditorTreeVisible: false });

    useUIStore.getState().switchWorkspaceMode(DIRECTORY, 'debug');

    expect(useUIStore.getState().contextEditorTreeVisible).toBe(true);
    const editorLeaf = findLeaf(panel()?.layout ?? CHAT_NODE, DEBUG_EDITOR_LEAF_ID);
    expect(editorLeaf?.tabs.some((id) => modeTabs('file').some((tab) => tab.id === id))).toBe(true);
  });

  test('board mode keeps its detail leaf for the Tracker and diffs', () => {
    useUIStore.getState().switchWorkspaceMode(DIRECTORY, 'board');
    expect(findLeaf(panel()?.layout ?? CHAT_NODE, BOARD_LIST_LEAF_ID)).not.toBeNull();

    useUIStore.getState().openTrackerItem(DIRECTORY, {
      url: 'https://example.com/repo/pull/42',
      key: 'pull/42',
      label: 'PR 42',
      targetDirectory: null,
    });

    const tabId = modeTabs('pr').find((tab) => tab.targetPath)?.id;
    const detailLeaf = findLeaf(panel()?.layout ?? CHAT_NODE, BOARD_DETAIL_LEAF_ID);
    expect(detailLeaf?.tabs).toContain(tabId);
  });

  test('a tracker item opened in chat mode suggests the board mode once', () => {
    useUIStore.getState().openTrackerItem(DIRECTORY, {
      url: 'https://example.com/repo/pull/7',
      key: 'pull/7',
      label: 'PR 7',
      targetDirectory: null,
    });
    expect(useUIStore.getState().workspaceModeOffer).toEqual({
      directory: DIRECTORY,
      mode: 'board',
      reason: 'tracker-item',
    });

    useUIStore.getState().dismissWorkspaceModeOffer();
    expect(useUIStore.getState().workspaceModeOffer).toBeNull();

    useUIStore.getState().openTrackerItem(DIRECTORY, {
      url: 'https://example.com/repo/pull/8',
      key: 'pull/8',
      label: 'PR 8',
      targetDirectory: null,
    });
    // Declined for this run: no second card for the same reason.
    expect(useUIStore.getState().workspaceModeOffer).toBeNull();
  });

  test('a mode already active offers nothing', () => {
    useUIStore.getState().switchWorkspaceMode(DIRECTORY, 'debug');
    useUIStore.getState().offerWorkspaceMode(DIRECTORY, 'debug', 'debug-run');
    expect(useUIStore.getState().workspaceModeOffer).toBeNull();
  });

  test('a full-page board closes when a mode takes the workspace', () => {
    useUIStore.getState().setSourceBoardOpen(true);
    useUIStore.getState().switchWorkspaceMode(DIRECTORY, 'board');
    expect(useUIStore.getState().isSourceBoardOpen).toBe(false);
  });
});
