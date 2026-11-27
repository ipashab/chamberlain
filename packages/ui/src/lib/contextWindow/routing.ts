import type { UIStore } from '@/stores/ui/types';

export const ROUTED_CONTEXT_ACTIONS = [
  'openContextSurface',
  'openContextSurfaceInLeaf',
  'openContextPanelTab',
  'openContextPanelTabToLeaf',
  'openTrackerItem',
  'openContextDiff',
  'openCommentLocation',
  'openContextFile',
  'openContextFileAtLine',
  'openContextOverview',
  'openContextPreview',
  'openContextBrowser',
  'openNewContextBrowserTab',
  'openAgentBrowserTab',
  'openProjectKnowledgePlan',
  'pinContextPanelTab',
  'setContextPanelTabTargetPath',
  'moveContextFilePaths',
  'setActiveContextPanelTab',
  'reorderContextPanelTabs',
  'moveContextPanelTabToLeaf',
  'closeContextPanelTab',
  'closeContextFile',
  'closeContextPanelTabs',
  'closeContextPanel',
  'splitLayoutRegion',
  'closeLayoutRegion',
  'balanceLayoutSplit',
  'switchWorkspaceMode',
  'moveContextSurfaceToZone',
  'setPendingDiffFile',
  'setPendingTurnDiffFile',
  'setPendingFileNavigation',
  'setPendingFileFocusPath',
  'navigateToDiff',
] as const;

export type RoutedContextAction = (typeof ROUTED_CONTEXT_ACTIONS)[number];

type Forwarder = (action: RoutedContextAction, args: readonly unknown[]) => boolean;

let forwarder: Forwarder | null = null;

export const setContextActionForwarder = (next: Forwarder | null): void => {
  forwarder = next;
};

const routed = <Args extends readonly unknown[], Result>(
  action: RoutedContextAction,
  run: (...args: Args) => Result,
  forwardedResult: Result,
) => (...args: Args): Result => (forwarder?.(action, args) ? forwardedResult : run(...args));

export const withContextWindowRouting = (store: UIStore): UIStore => ({
  ...store,
  ...({
    openContextSurface: routed('openContextSurface', store.openContextSurface, undefined),
    openContextSurfaceInLeaf: routed('openContextSurfaceInLeaf', store.openContextSurfaceInLeaf, undefined),
    openContextPanelTab: routed('openContextPanelTab', store.openContextPanelTab, undefined),
    openContextPanelTabToLeaf: routed('openContextPanelTabToLeaf', store.openContextPanelTabToLeaf, undefined),
    openTrackerItem: routed('openTrackerItem', store.openTrackerItem, null),
    openContextDiff: routed('openContextDiff', store.openContextDiff, undefined),
    openCommentLocation: routed('openCommentLocation', store.openCommentLocation, undefined),
    openContextFile: routed('openContextFile', store.openContextFile, undefined),
    openContextFileAtLine: routed('openContextFileAtLine', store.openContextFileAtLine, undefined),
    openContextOverview: routed('openContextOverview', store.openContextOverview, undefined),
    openContextPreview: routed('openContextPreview', store.openContextPreview, undefined),
    openContextBrowser: routed('openContextBrowser', store.openContextBrowser, undefined),
    openNewContextBrowserTab: routed('openNewContextBrowserTab', store.openNewContextBrowserTab, undefined),
    openAgentBrowserTab: routed('openAgentBrowserTab', store.openAgentBrowserTab, null),
    openProjectKnowledgePlan: routed('openProjectKnowledgePlan', store.openProjectKnowledgePlan, undefined),
    pinContextPanelTab: routed('pinContextPanelTab', store.pinContextPanelTab, undefined),
    setContextPanelTabTargetPath: routed('setContextPanelTabTargetPath', store.setContextPanelTabTargetPath, undefined),
    moveContextFilePaths: routed('moveContextFilePaths', store.moveContextFilePaths, undefined),
    setActiveContextPanelTab: routed('setActiveContextPanelTab', store.setActiveContextPanelTab, undefined),
    reorderContextPanelTabs: routed('reorderContextPanelTabs', store.reorderContextPanelTabs, undefined),
    moveContextPanelTabToLeaf: routed('moveContextPanelTabToLeaf', store.moveContextPanelTabToLeaf, undefined),
    closeContextPanelTab: routed('closeContextPanelTab', store.closeContextPanelTab, undefined),
    closeContextFile: routed('closeContextFile', store.closeContextFile, undefined),
    closeContextPanelTabs: routed('closeContextPanelTabs', store.closeContextPanelTabs, undefined),
    closeContextPanel: routed('closeContextPanel', store.closeContextPanel, undefined),
    splitLayoutRegion: routed('splitLayoutRegion', store.splitLayoutRegion, null),
    closeLayoutRegion: routed('closeLayoutRegion', store.closeLayoutRegion, undefined),
    balanceLayoutSplit: routed('balanceLayoutSplit', store.balanceLayoutSplit, undefined),
    switchWorkspaceMode: routed('switchWorkspaceMode', store.switchWorkspaceMode, undefined),
    moveContextSurfaceToZone: routed('moveContextSurfaceToZone', store.moveContextSurfaceToZone, undefined),
    setPendingDiffFile: routed('setPendingDiffFile', store.setPendingDiffFile, undefined),
    setPendingTurnDiffFile: routed('setPendingTurnDiffFile', store.setPendingTurnDiffFile, undefined),
    setPendingFileNavigation: routed('setPendingFileNavigation', store.setPendingFileNavigation, undefined),
    setPendingFileFocusPath: routed('setPendingFileFocusPath', store.setPendingFileFocusPath, undefined),
    navigateToDiff: routed('navigateToDiff', store.navigateToDiff, undefined),
  } satisfies Pick<UIStore, RoutedContextAction>),
});
