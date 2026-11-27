import { describe, expect, test } from 'bun:test';
import { CHAT_NODE } from '@/lib/workspace/layoutTree';
import type { ContextPanelDirectoryState, ContextPanelTab } from '@/stores/ui/types';
import { closeEveryRegion, latestPanelOwner, withPanelEntry, withoutPanelEntry, EMPTY_CONTEXT_WINDOW_RECORD } from './layoutState';

const tab = (id: string, mode: ContextPanelTab['mode']): ContextPanelTab => ({
  id,
  mode,
  targetPath: null,
  targetDirectory: null,
  dedupeKey: id,
  label: null,
  sessionTitleFallback: null,
  readOnly: false,
  stagedDiff: false,
  diffScope: null,
  preview: false,
  ownerSessionId: null,
  touchedAt: 1,
});

const splitTree = {
  kind: 'split',
  id: 'split-1',
  axis: 'row',
  fractions: [0.5, 0.5],
  children: [
    { kind: 'chat' },
    { kind: 'leaf', id: 'leaf-1', tabs: ['git'], activeTabId: 'git' },
  ],
} as const;

const panel = (overrides: Partial<ContextPanelDirectoryState>): ContextPanelDirectoryState => ({
  isOpen: true,
  expanded: false,
  tabs: [tab('git', 'git')],
  activeTabId: 'git',
  zones: { left: { isOpen: true, expanded: false, activeTabId: 'git' }, bottom: { isOpen: false, expanded: false, activeTabId: null } },
  layout: splitTree as unknown as ContextPanelDirectoryState['layout'],
  workspaceMode: 'chat',
  modeLayouts: {},
  touchedAt: 1,
  ...overrides,
});

describe('closeEveryRegion', () => {
  test('folds every tree to the chat node, keeps the tabs and silences the legacy views', () => {
    const closed = closeEveryRegion({ '/repo': panel({}), '/other': panel({ isOpen: false, layout: CHAT_NODE }) });

    expect(closed['/repo'].layout).toBe(CHAT_NODE);
    // Tabs survive the detach: they come back with the panel.
    expect(closed['/repo'].tabs.map((entry) => entry.id)).toEqual(['git']);
    expect(closed['/repo'].isOpen).toBe(false);
    expect(closed['/repo'].expanded).toBe(false);
    expect(closed['/repo'].zones.left.isOpen).toBe(false);
    expect(closed['/repo'].zones.left.activeTabId).toBeNull();
    expect(closed['/other'].layout).toBe(CHAT_NODE);
  });
});

describe('panel window records', () => {
  test('withPanelEntry keeps at most eight owners, the most recently touched', () => {
    let record = EMPTY_CONTEXT_WINDOW_RECORD;
    for (let index = 0; index < 10; index += 1) {
      record = withPanelEntry(record, `owner-${index}`, { byDirectory: {}, touchedAt: index });
    }
    expect(Object.keys(record.panels).sort()).toEqual(
      ['owner-2', 'owner-3', 'owner-4', 'owner-5', 'owner-6', 'owner-7', 'owner-8', 'owner-9'],
    );

    record = withPanelEntry(record, 'owner-new', { byDirectory: {}, touchedAt: 100 });
    expect(record.panels['owner-new'].touchedAt).toBe(100);
    expect(record.panels['owner-2']).toBeUndefined();
  });

  test('withoutPanelEntry drops one owner and keeps the others', () => {
    let record = withPanelEntry(EMPTY_CONTEXT_WINDOW_RECORD, 'owner-a', { byDirectory: {}, touchedAt: 1 });
    record = withPanelEntry(record, 'owner-b', { byDirectory: {}, touchedAt: 2 });
    record = withoutPanelEntry(record, 'owner-a');
    expect(Object.keys(record.panels)).toEqual(['owner-b']);
  });

  test('latestPanelOwner picks the most recently touched among the candidates', () => {
    let record = withPanelEntry(EMPTY_CONTEXT_WINDOW_RECORD, 'owner-a', { byDirectory: {}, touchedAt: 10 });
    record = withPanelEntry(record, 'owner-b', { byDirectory: {}, touchedAt: 5 });
    expect(latestPanelOwner(record, new Set(['owner-a', 'owner-b']))).toBe('owner-a');
    expect(latestPanelOwner(record, new Set(['owner-b']))).toBe('owner-b');
    expect(latestPanelOwner(record, new Set(['owner-c']))).toBeNull();
  });
});
