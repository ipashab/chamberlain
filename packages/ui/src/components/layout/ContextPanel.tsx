import React from 'react';

import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { DiffViewIcon } from '@/components/icons/DiffIcon';
import { RegionSurfaceMenu } from './RegionSurfaceMenu';
import { Button } from '@/components/ui/button';
import { ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu';
import { SortableTabsStrip } from '@/components/ui/sortable-tabs-strip';
import { PullRequestView } from '@/components/views/PullRequestView';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';

// Heavy views stay on-demand (same as MainLayout): importing GitView or the
// plan statically pulls their stacks into the eager startup graph even when
// no such tab is open. The keep-alive surfaces load in ContextSurfacePanes.
const GitView = lazyWithChunkRecovery(() => import('@/components/views/GitView').then((m) => ({ default: m.GitView })));
const PlanView = lazyWithChunkRecovery(() => import('@/components/views/PlanView').then((m) => ({ default: m.PlanView })));
const BitbucketPullsPanel = lazyWithChunkRecovery(() => import('@/components/bitbucket/BitbucketPullsPanel').then((m) => ({ default: m.BitbucketPullsPanel })));
const JiraIssuesPanel = lazyWithChunkRecovery(() => import('@/components/jira/JiraIssuesPanel').then((m) => ({ default: m.JiraIssuesPanel })));
const ConfluencePagesPanel = lazyWithChunkRecovery(() => import('@/components/confluence/ConfluencePagesPanel').then((m) => ({ default: m.ConfluencePagesPanel })));
const ReviewDashboard = lazyWithChunkRecovery(() => import('@/components/review/ReviewDashboard').then((m) => ({ default: m.ReviewDashboard })));
import { areTitleMapsEqual, buildSessionTitleMap, EMPTY_SESSION_TITLE_MAP, getSessionIDFromDedupeKey } from './contextPanelSessionTitles';
import { ProjectContextPanel } from './RightSidebarTabs';
import { TeamBoardView } from '@/components/chat/work-status/TeamBoardView';
import type { TeamMember } from '@/lib/team/team-board-api';
import { ChatView } from '@/components/views/ChatView';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useRepositoryReferenceProvider } from '@/components/references/referenceSources';
import { useGuestSurfaces } from '@/hooks/useGuestSurfaces';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useBrowserFaviconStore } from '@/stores/useBrowserFaviconStore';
import { useUIStore, type ContextPanelMode, type ContextPanelTab } from '@/stores/useUIStore';
import { useChildStoreManager } from '@/sync/sync-context';
import { ContextPanelContent } from './ContextSidebarTab';
import { browserUrlLabel } from '@/lib/browser/url';
import { Icon } from "@/components/icon/Icon";
import { GuestIcon } from './GuestRailIcon';
import { useGuestsStore } from '@/lib/guests/store';
import { FALLBACK_GUEST_ICON } from '@/lib/guests/icon';
import { isPluginContextPanelMode, pluginIdFromMode } from '@/lib/surfaces/modes';
import { changeRequestCopy } from '@/lib/source-control/changeRequestCopy';
import { ContextPanelHeaderSlotProvider } from './contextPanelHeaderSlot';
import { closeZoneOnEscape } from './zoneEscape';
import { setRegionBody, setRegionHeaderSlot } from './regionHosts';
import { findLeaf, leavesOf } from '@/lib/workspace/layoutTree';

const CONTEXT_TAB_LABEL_MAX_CHARS = 24;
type TranslateFn = ReturnType<typeof useI18n>['t'];

const normalizeDirectoryKey = (value: string): string => {
  if (!value) return '';

  const raw = value.replace(/\\/g, '/');
  const hadUncPrefix = raw.startsWith('//');
  let normalized = raw.replace(/\/+$/g, '');
  normalized = normalized.replace(/\/+/g, '/');

  if (hadUncPrefix && !normalized.startsWith('//')) {
    normalized = `/${normalized}`;
  }

  if (normalized === '') {
    return raw.startsWith('/') ? '/' : '';
  }

  return normalized;
};

const getRelativePathLabel = (filePath: string | null, directory: string): string => {
  if (!filePath) {
    return '';
  }
  const normalizedFile = filePath.replace(/\\/g, '/');
  const normalizedDir = directory.replace(/\\/g, '/').replace(/\/+$/, '');
  if (normalizedDir && normalizedFile.startsWith(normalizedDir + '/')) {
    return normalizedFile.slice(normalizedDir.length + 1);
  }
  return normalizedFile;
};

const getModeLabel = (
  mode: ContextPanelMode,
  t: TranslateFn
): string => {
  if (mode === 'chat') return t('contextPanel.mode.chat');
  if (mode === 'file') return t('contextPanel.mode.files');
  if (mode === 'diff') return t('contextPanel.mode.diff');
  if (mode === 'walkthrough') return t('contextPanel.mode.walkthrough');
  if (mode === 'plan') return t('contextPanel.mode.plan');
  if (mode === 'browser') return t('contextPanel.mode.browser');
  if (mode === 'git') return t('layout.rightSidebar.git');
  if (mode === 'pr') return t('contextPanel.mode.pr');
  if (mode === 'notes') return t('contextRail.surface.notes');
  if (mode === 'terminal') return t('layout.mainTab.terminal');
  if (mode === 'team') return t('contextPanel.mode.team');
  if (mode === 'pulls') return t('contextPanel.mode.pulls');
  if (mode === 'jira') return t('contextPanel.mode.jira');
  if (mode === 'confluence') return t('contextPanel.mode.confluence');
  if (mode === 'review') return t('contextPanel.mode.review');
  if (isPluginContextPanelMode(mode)) {
    const guest = useGuestsStore.getState().guests.find((entry) => entry.id === pluginIdFromMode(mode));
    return guest?.name ?? t('contextRail.surface.plugin');
  }
  return t('contextPanel.mode.context');
};

const getFileNameFromPath = (path: string | null): string | null => {
  if (!path) {
    return null;
  }

  const normalized = path.replace(/\\/g, '/').trim();
  if (!normalized) {
    return null;
  }

  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0) {
    return normalized;
  }

  return segments[segments.length - 1] || null;
};

const getTabLabel = (
  tab: { mode: ContextPanelMode; label: string | null; targetPath: string | null; dedupeKey?: string; sessionTitleFallback?: string | null; stagedDiff?: boolean },
  sessionTitleById: ReadonlyMap<string, string>,
  t: TranslateFn
): string => {
  if (tab.mode === 'chat') {
    const sessionID = getSessionIDFromDedupeKey(tab.dedupeKey);
    if (sessionID) {
      const sessionTitle = sessionTitleById.get(sessionID)?.trim();
      if (sessionTitle) {
        return sessionTitle;
      }
    }

    const sessionTitleFallback = tab.sessionTitleFallback?.trim();
    if (sessionTitleFallback) {
      return sessionTitleFallback;
    }

    return t('contextPanel.mode.chat');
  }

  // Ahead of the stored label on purpose: a browser tab is named after the page
  // it is showing, and the stored label is only ever the address it opened at.
  // Keeping that would leave the tab claiming one host while the address bar
  // shows another.
  if (tab.mode === 'browser') {
    return browserUrlLabel(tab.targetPath ?? '') || tab.label || t('contextPanel.mode.browser');
  }

  if (tab.label) {
    return tab.label;
  }

  if (tab.mode === 'file') {
    return getFileNameFromPath(tab.targetPath) || t('contextPanel.mode.files');
  }

  if (tab.mode === 'diff') {
    return t('contextPanel.mode.diff');
  }

  return getModeLabel(tab.mode, t);
};

const ContextGuestIcon: React.FC<{ mode: ContextPanelMode }> = ({ mode }) => {
  const surfaces = useGuestSurfaces();
  const surface = surfaces.find((entry) => entry.mode === mode);
  return <GuestIcon icon={surface?.icon ?? FALLBACK_GUEST_ICON} iconSrc={surface?.iconSrc} className="h-3.5 w-3.5" />;
};

const getTabIcon = (
  tab: { mode: ContextPanelMode; targetPath: string | null },
  faviconByOrigin: Record<string, string> = {},
): React.ReactNode | undefined => {
  if (tab.mode === 'file') {
    return tab.targetPath
      ? <FileTypeIcon filePath={tab.targetPath} className="h-3.5 w-3.5" />
      : undefined;
  }

  if (tab.mode === 'diff') {
    return <DiffViewIcon className="h-3.5 w-3.5" />;
  }

  if (tab.mode === 'walkthrough') {
    return <Icon name="route" className="h-3.5 w-3.5" />;
  }

  if (tab.mode === 'git') {
    return <Icon name="git-branch" className="h-3.5 w-3.5" />;
  }

  if (tab.mode === 'pr') {
    return <Icon name="github" className="h-3.5 w-3.5" />;
  }

  if (tab.mode === 'notes') {
    return <Icon name="sticky-note" className="h-3.5 w-3.5" />;
  }

  if (tab.mode === 'terminal') {
    return <Icon name="terminal-box" className="h-3.5 w-3.5" />;
  }

  if (tab.mode === 'team') {
    return <Icon name="layout-column" className="h-3.5 w-3.5" />;
  }

  if (tab.mode === 'pulls') {
    return <Icon name="git-pull-request" className="h-3.5 w-3.5" />;
  }

  if (tab.mode === 'plan') {
    return <Icon name="file-text" className="h-3.5 w-3.5" />;
  }

  if (tab.mode === 'context') {
    return <Icon name="donut-chart-fill" className="h-3.5 w-3.5" />;
  }

  if (tab.mode === 'chat') {
    return <Icon name="chat-4" className="h-3.5 w-3.5" />;
  }

  if (isPluginContextPanelMode(tab.mode)) {
    return <ContextGuestIcon mode={tab.mode} />;
  }

  if (tab.mode === 'browser') {
    const icon = browserFaviconFor(tab.targetPath ?? '', faviconByOrigin);
    // The page's own icon when it has reported one; the placeholder otherwise,
    // including in runtimes where a page never can.
    return icon
      ? <img src={icon} alt="" aria-hidden="true" className="h-3.5 w-3.5 rounded-[3px] object-contain" />
      : <Icon name="global" className="h-3.5 w-3.5" />;
  }

  return undefined;
};

const browserFaviconFor = (url: string, faviconByOrigin: Record<string, string>): string => {
  try {
    return faviconByOrigin[new URL(url).origin] ?? '';
  } catch {
    return '';
  }
};

// A team-board tab is pinned to the session it was opened from, the same way
// a split chat is; without that it could not say which team to draw after a
// session switch.
const getTeamSessionIDFromDedupeKey = (dedupeKey: string | undefined): string | null => {
  if (!dedupeKey || !dedupeKey.startsWith('team:')) {
    return null;
  }

  const sessionID = dedupeKey.slice('team:'.length).trim();
  return sessionID || null;
};

// Titles come from every live directory because a chat tab may show a
// session from another project; an inactive tab whose directory is not
// loaded keeps its sessionTitleFallback.
const useSessionTitleMap = (sessionIDs: readonly string[]): ReadonlyMap<string, string> => {
  const childStores = useChildStoreManager();
  const snapshotRef = React.useRef<ReadonlyMap<string, string>>(EMPTY_SESSION_TITLE_MAP);
  const sessionIDsRef = React.useRef<readonly string[]>(sessionIDs);

  sessionIDsRef.current = sessionIDs;
  // No titles wanted, no subscription: every session update would wake it.
  const wanted = sessionIDs.length > 0;

  return React.useSyncExternalStore(
    React.useCallback(
      (notify: () => void) => (wanted ? childStores.subscribeAllSelected((state) => state.session, notify) : () => undefined),
      [childStores, wanted],
    ),
    React.useCallback(() => {
      const liveStates = Array.from(childStores.children.values(), (store) => store.getState());
      const next = buildSessionTitleMap(liveStates, sessionIDsRef.current);
      if (areTitleMapsEqual(snapshotRef.current, next)) {
        return snapshotRef.current;
      }
      snapshotRef.current = next;
      return next;
    }, [childStores]),
    () => EMPTY_SESSION_TITLE_MAP,
  );
};


const truncateTabLabel = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars - 3)}...`;
};


// Surfaces rendered by the region itself and remounted on every switch; the
// rest stay alive in ContextSurfacePanes.
const isRemountedSurface = (mode: ContextPanelMode): boolean => (
  mode === 'context' || mode === 'git' || mode === 'pr' || mode === 'notes' || mode === 'plan'
    || mode === 'team' || mode === 'pulls' || mode === 'jira' || mode === 'confluence' || mode === 'review'
);

/**
 * One region of the workspace layout: a leaf of the tree with its frame,
 * header, tab strip and the surfaces that remount on every switch. The
 * keep-alive surfaces are portalled into the body from `ContextSurfacePanes`,
 * under this leaf's id.
 */
export const ContextPanel: React.FC<{ leafId: string; chatCovered: boolean }> = ({ leafId, chatCovered }) => {
  const { t } = useI18n();
  const effectiveDirectory = useEffectiveDirectory() ?? '';
  const repositoryProvider = useRepositoryReferenceProvider(effectiveDirectory || null);
  // Tab names in this repository's words: a GitLab project's change request tab is a merge request.
  const tabT = React.useCallback<TranslateFn>(
    (key, params) => t(changeRequestCopy(key, repositoryProvider), params),
    [repositoryProvider, t],
  );
  const directoryKey = React.useMemo(() => normalizeDirectoryKey(effectiveDirectory), [effectiveDirectory]);

  const panelState = useUIStore((state) => (directoryKey ? state.contextPanelByDirectory[directoryKey] : undefined));
  const leaf = React.useMemo(
    () => (panelState ? findLeaf(panelState.layout, leafId) : null),
    [leafId, panelState],
  );

  const splitLayoutRegion = useUIStore((state) => state.splitLayoutRegion);
  const closeLayoutRegion = useUIStore((state) => state.closeLayoutRegion);
  const closeContextPanelTab = useUIStore((state) => state.closeContextPanelTab);
  const closeContextPanelTabs = useUIStore((state) => state.closeContextPanelTabs);
  const pinContextPanelTab = useUIStore((state) => state.pinContextPanelTab);
  const setActiveContextPanelTab = useUIStore((state) => state.setActiveContextPanelTab);
  const moveContextPanelTabToLeaf = useUIStore((state) => state.moveContextPanelTabToLeaf);
  const contextEditorTreeVisible = useUIStore((state) => state.contextEditorTreeVisible);
  const contextEditorVisible = useUIStore((state) => state.contextEditorVisible);
  const toggleContextEditorTree = useUIStore((state) => state.toggleContextEditorTree);
  const toggleContextEditor = useUIStore((state) => state.toggleContextEditor);
  const fileTreeSide = useUIStore((state) => state.fileTreeSide);
  const openNewContextBrowserTab = useUIStore((state) => state.openNewContextBrowserTab);
  const faviconByOrigin = useBrowserFaviconStore((state) => state.byOrigin);
  const [headerSlotEl, setHeaderSlotEl] = React.useState<HTMLDivElement | null>(null);
  const registerHeaderSlot = React.useCallback((element: HTMLDivElement | null) => {
    setHeaderSlotEl(element);
    setRegionHeaderSlot(leafId, element);
  }, [leafId]);
  const registerBody = React.useCallback((element: HTMLDivElement | null) => {
    setRegionBody(leafId, element);
  }, [leafId]);

  // This leaf's tabs, in this leaf's order. Tabs themselves live in the
  // shared strip; the leaf only holds ids.
  const tabs = React.useMemo(() => {
    if (!leaf) return [];
    const byId = new Map((panelState?.tabs ?? []).map((tab) => [tab.id, tab]));
    const own: ContextPanelTab[] = [];
    for (const id of leaf.tabs) {
      const tab = byId.get(id);
      if (tab) own.push(tab);
    }
    return own;
  }, [leaf, panelState?.tabs]);
  const activeTab = React.useMemo(
    () => (leaf?.activeTabId ? tabs.find((tab) => tab.id === leaf.activeTabId) ?? null : null),
    [leaf?.activeTabId, tabs],
  );
  const isOpen = tabs.length > 0;
  const covered = chatCovered;

  const hasOpenEditorFile = React.useMemo(
    () => tabs.some((tab) => tab.mode === 'file' && tab.targetPath),
    [tabs],
  );
  // The editor column is shown for an open file unless the user hid it; the
  // tree never hides alongside it, so a hidden tree forces the editor back.
  const showsEditor = hasOpenEditorFile && (contextEditorVisible || !contextEditorTreeVisible);

  const handleSplit = React.useCallback((axis: 'row' | 'column') => {
    if (!directoryKey) return;
    splitLayoutRegion(directoryKey, { leafId }, axis, 0.5);
  }, [directoryKey, leafId, splitLayoutRegion]);

  const handleClose = React.useCallback(() => {
    if (!directoryKey) {
      return;
    }
    closeLayoutRegion(directoryKey, leafId);
  }, [closeLayoutRegion, directoryKey, leafId]);

  const handlePanelKeyDownCapture = React.useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    closeZoneOnEscape(event, true, handleClose);
  }, [handleClose]);

  // The panel takes focus when it gains content after being empty: the open
  // that lands a tab here is a reason to put the keyboard inside the region.
  const panelRef = React.useRef<HTMLElement | null>(null);
  const wasFilledRef = React.useRef(false);
  React.useEffect(() => {
    if (!isOpen || wasFilledRef.current) {
      wasFilledRef.current = isOpen;
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      panelRef.current?.focus({ preventScroll: true });
    });
    wasFilledRef.current = true;
    return () => window.cancelAnimationFrame(frame);
  }, [isOpen]);

  // Titles are for this region's chat tab strip only; a region that is empty
  // or shows another surface subscribes to none.
  const showsChatTabs = isOpen && activeTab?.mode === 'chat';
  const chatSessionIDs = React.useMemo(() => {
    const ids: string[] = [];
    if (!showsChatTabs) return ids;
    for (const tab of tabs) {
      if (tab.mode !== 'chat') continue;
      const sessionID = getSessionIDFromDedupeKey(tab.dedupeKey);
      if (sessionID && !ids.includes(sessionID)) ids.push(sessionID);
    }
    return ids;
  }, [showsChatTabs, tabs]);
  const sessionTitleById = useSessionTitleMap(chatSessionIDs);

  // The rail switches between surfaces (modes); the in-region strip only lists
  // instances of the active multi-instance surface (open files, split chats,
  // browser targets).
  const isMultiInstanceMode = activeTab?.mode === 'file' || activeTab?.mode === 'chat' || activeTab?.mode === 'browser';
  const activeModeTabs = React.useMemo(
    () => (activeTab ? tabs.filter((tab) => tab.mode === activeTab.mode) : []),
    [activeTab, tabs],
  );

  const tabItems = React.useMemo(() => activeModeTabs.map((tab) => {
    const rawLabel = getTabLabel(tab, sessionTitleById, tabT);
    const label = truncateTabLabel(rawLabel, CONTEXT_TAB_LABEL_MAX_CHARS);
    const tabPathLabel = getRelativePathLabel(tab.targetPath, effectiveDirectory);
    return {
      id: tab.id,
      label,
      icon: getTabIcon(tab, faviconByOrigin),
      title: tabPathLabel ? `${rawLabel}: ${tabPathLabel}` : rawLabel,
      closeLabel: t('contextPanel.tab.closeTabAria', { label }),
      preview: tab.preview,
    };
  }), [activeModeTabs, effectiveDirectory, faviconByOrigin, sessionTitleById, t, tabT]);

  // Injected by the panel on purpose: TeamBoardView importing ChatView
  // directly would close the ChatContainer → WorkStatusPanel → … →
  // TeamBoardView module cycle. The board view owns the toggle; the panel
  // owns the pinned chat columns.
  const renderTeamChatColumn = React.useCallback(
    (member: TeamMember, directory: string): React.ReactNode => (
      <ChatView readOnly pinnedSession={{ sessionId: member.sessionId, directory }} />
    ),
    [],
  );

  const activeNonChatContent = activeTab?.mode === 'context'
        ? <ContextPanelHeaderSlotProvider value={headerSlotEl}><ContextPanelContent /></ContextPanelHeaderSlotProvider>
        : activeTab?.mode === 'git'
            ? <React.Suspense fallback={null}><ContextPanelHeaderSlotProvider value={headerSlotEl}><GitView isActive={isOpen} /></ContextPanelHeaderSlotProvider></React.Suspense>
            : activeTab?.mode === 'pr'
                ? <PullRequestView />
            : activeTab?.mode === 'notes'
                ? <ContextPanelHeaderSlotProvider value={headerSlotEl}><ProjectContextPanel visible={isOpen} /></ContextPanelHeaderSlotProvider>
        : activeTab?.mode === 'plan'
            ? <React.Suspense fallback={null}><ContextPanelHeaderSlotProvider value={headerSlotEl}><PlanView
                targetPath={activeTab.targetPath}
                savedProjectPlan={activeTab.projectPlanId && activeTab.projectPlanRef
                  ? { projectRef: activeTab.projectPlanRef, planId: activeTab.projectPlanId }
                  : null}
              /></ContextPanelHeaderSlotProvider></React.Suspense>
            : activeTab?.mode === 'team'
                ? <div className="flex h-full min-h-0 flex-col p-3"><TeamBoardView
                    sessionId={getTeamSessionIDFromDedupeKey(activeTab.dedupeKey)}
                    directory={effectiveDirectory}
                    chatColumn={renderTeamChatColumn}
                  /></div>
            : activeTab?.mode === 'pulls'
                ? <React.Suspense fallback={null}><BitbucketPullsPanel /></React.Suspense>
            : activeTab?.mode === 'jira'
                ? <React.Suspense fallback={null}><JiraIssuesPanel /></React.Suspense>
            : activeTab?.mode === 'confluence'
                ? <React.Suspense fallback={null}><ConfluencePagesPanel /></React.Suspense>
            : activeTab?.mode === 'review'
                ? <React.Suspense fallback={null}><ReviewDashboard /></React.Suspense>
            : null;

  const isFileTabActive = activeTab?.mode === 'file';

  const renderTabContextMenu = React.useCallback(
    (args: { id: string; allIds: string[]; close: () => void }): React.ReactNode => {
      if (!directoryKey) {
        return null;
      }
      const { id, allIds, close } = args;
      const closeOthers = () => closeContextPanelTabs(directoryKey, allIds.filter((tabId) => tabId !== id));
      const closeAll = () => closeContextPanelTabs(directoryKey, allIds);
      const hasOthers = allIds.length > 1;
      // Other regions this tab could move to, with the tab they show (an
      // empty region moves the tab alone; a filled one takes it as a tab).
      const otherLeaves = panelState ? leavesOf(panelState.layout).filter((entry) => entry.id !== leafId) : [];
      const labelOfLeaf = (entryId: string) => {
        const entry = otherLeaves.find((candidate) => candidate.id === entryId);
        if (!entry) return null;
        const entryTab = entry.activeTabId
          ? (panelState?.tabs ?? []).find((tab) => tab.id === entry.activeTabId)
          : null;
        return entryTab?.label ?? entryTab?.sessionTitleFallback ?? t('contextPanel.region.empty');
      };
      return (
        <>
          <ContextMenuItem onClick={close}>
            <Icon name="close" className="me-2 size-4" />
            {t('contextPanel.tab.menu.close')}
          </ContextMenuItem>
          {otherLeaves.length > 0 && (
            <ContextMenuSeparator />
          )}
          {otherLeaves.map((entry) => (
            <ContextMenuItem
              key={entry.id}
              onClick={() => moveContextPanelTabToLeaf(directoryKey, id, entry.id)}
            >
              <Icon name="arrow-right" className="me-2 size-4" />
              {t('contextPanel.tab.menu.moveToRegion')}
              <span className="ms-2 max-w-40 truncate text-muted-foreground">{labelOfLeaf(entry.id)}</span>
            </ContextMenuItem>
          ))}
          <ContextMenuSeparator />
          <ContextMenuItem onClick={closeOthers} disabled={!hasOthers}>
            <Icon name="close-circle" className="me-2 size-4" />
            {t('contextPanel.tab.menu.closeOthers')}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={closeAll} disabled={!hasOthers}>
            <Icon name="close-circle" className="me-2 size-4" />
            {t('contextPanel.tab.menu.closeAll')}
          </ContextMenuItem>
        </>
      );
    },
    [closeContextPanelTabs, directoryKey, leafId, moveContextPanelTabToLeaf, panelState, t],
  );

  const header = (
    <header
      className="group/panel-header flex min-h-10 select-none items-stretch border-b border-border"
    >
      {isMultiInstanceMode && activeTab ? (
        <SortableTabsStrip
          items={tabItems}
          activeId={activeTab?.id ?? null}
          onSelect={(tabID) => {
            if (!directoryKey) {
              return;
            }
            setActiveContextPanelTab(directoryKey, tabID);
          }}
          onClose={(tabID) => {
            if (!directoryKey) {
              return;
            }
            closeContextPanelTab(directoryKey, tabID);
          }}
          onReorder={(activeTabID, overTabID) => {
            // Reordering inside this leaf: the over tab's slot in the leaf.
            if (!directoryKey || !leaf) {
              return;
            }
            moveContextPanelTabToLeaf(directoryKey, activeTabID, leafId, leaf.tabs.indexOf(overTabID));
          }}
          onDoubleClickTab={(tabID) => {
            if (directoryKey) pinContextPanelTab(directoryKey, tabID);
          }}
          layoutMode="scrollable"
          variant="default"
          tabContextMenu={renderTabContextMenu}
        />
      ) : (
        <>
        <div className="flex min-w-0 flex-1 items-center gap-1.5 px-3 group-has-[[data-context-panel-toolbar]]/panel-header:hidden">
          {/* A GitLab project's change requests are merge requests. */}
          {activeTab?.mode === 'pr' && repositoryProvider === 'gitlab'
            ? <Icon name="gitlab" className="h-3.5 w-3.5" />
            : activeTab ? getTabIcon(activeTab, faviconByOrigin) : null}
          <span className="truncate typography-ui-label text-foreground">
            {activeTab?.mode === 'pr' && repositoryProvider === 'gitlab'
              ? t('contextPanel.mode.mr')
              : activeTab ? getModeLabel(activeTab.mode, tabT) : t('contextPanel.region.empty')}
          </span>
        </div>
        {/* The active surface's own toolbar lands here (contextPanelHeaderSlot). */}
        <div ref={registerHeaderSlot} className="flex min-w-0 flex-1 items-stretch ps-1.5 empty:hidden" />
        </>
      )}
      <div className="flex h-10 shrink-0 items-center gap-1 self-start px-1.5">
        {activeTab?.mode === 'browser' ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              if (!directoryKey) return;
              openNewContextBrowserTab(directoryKey);
            }}
            className="h-7 w-7 p-0"
            title={t('contextPanel.browser.newTab')}
            aria-label={t('contextPanel.browser.newTab')}
          >
            <Icon name="add" className="h-3.5 w-3.5" />
          </Button>
        ) : null}
        {/* Each icon toggles the column on its side: the editor and the tree
            swap sides with the file tree side setting, the icons stay put. */}
        {isFileTabActive ? (['left', 'right'] as const).map((side) => {
          const isTree = side === fileTreeSide;
          if (!isTree && !hasOpenEditorFile) return null;
          const label = isTree ? t('contextRail.editorTree.toggle') : t('contextRail.editor.toggle');
          return (
            <Button
              key={side}
              type="button"
              variant="ghost"
              size="sm"
              onClick={isTree ? toggleContextEditorTree : toggleContextEditor}
              className="h-7 w-7 p-0"
              title={label}
              aria-label={label}
              aria-pressed={isTree ? contextEditorTreeVisible : showsEditor}
            >
              <Icon name={side === 'left' ? 'layout-left' : 'layout-right'} className="h-3.5 w-3.5" />
            </Button>
          );
        }) : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => handleSplit('row')}
          className="h-7 w-7 p-0"
          title={t('contextPanel.region.split.row')}
          aria-label={t('contextPanel.region.split.row')}
        >
          <Icon name="expand-horizontal" className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => handleSplit('column')}
          className="h-7 w-7 p-0"
          title={t('contextPanel.region.split.column')}
          aria-label={t('contextPanel.region.split.column')}
        >
          <Icon name="expand-up-down" className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleClose}
          className="h-7 w-7 p-0"
          title={t('contextPanel.region.close')}
          aria-label={t('contextPanel.region.close')}
        >
          <Icon name="close" className="h-3.5 w-3.5" />
        </Button>
      </div>
    </header>
  );

  return (
    <section
      ref={panelRef}
      data-context-panel="true"
      data-context-panel-open={isOpen ? 'true' : 'false'}
      data-region-leaf={leafId}
      tabIndex={-1}
      className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden"
      onKeyDownCapture={handlePanelKeyDownCapture}
    >
      <div
        className={cn(
          'oc-panel-edge relative z-10 m-1 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[10px] bg-background',
          !isOpen && 'border-dashed',
        )}
        inert={covered || undefined}
      >
        {header}
        {/* Keep-alive surfaces (ContextSurfacePanes) are portalled in here. */}
        <div ref={registerBody} className="relative min-h-0 flex-1 overflow-hidden">
          {activeTab && isRemountedSurface(activeTab.mode) ? activeNonChatContent : null}
          {!isOpen && activeTab === null && leaf && (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
              <span className="typography-ui-label text-muted-foreground">{t('contextPanel.region.empty')}</span>
              <RegionSurfaceMenu leafId={leafId} directoryKey={directoryKey} />
              <span className="text-sm text-muted-foreground" data-region-split-hint>
                {t('contextPanel.region.splitHint')}
              </span>
              <span className="hidden text-sm text-muted-foreground" data-region-drop-hint>
                {t('contextPanel.region.dropSession')}
              </span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
};
