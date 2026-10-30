import React from 'react';

import { TerminalView } from '@/components/views/TerminalView';
import { DebugView } from '@/components/views/DebugView';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import { BrowserPane } from '@/components/browser/BrowserPane';
import { ChatView } from '@/components/views/ChatView';
import { Icon } from '@/components/icon/Icon';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useDraftSpaceTarget } from '@/lib/spaces/useDraftSpaceTarget';
import { panelContentDirectory } from '@/lib/spaces/space-creation-requests';
import { spaceIdOfDirectory } from '@/lib/spaces/space-route';
import { SpacePreparing } from '@/components/session/spaces/SpacePreparing';
import { resolvePlanRequestOwner } from '@/hooks/useProjectContextOwner';
import { isRightToLeft, useI18n } from '@/lib/i18n';
import { resolveProjectContextId } from '@/lib/projectContextApi';
import { cn } from '@/lib/utils';
import { registerBrowserCloser, registerBrowserOpener, registerSleepingBrowserTab, setShownBrowserTab } from '@/lib/browser/controlClient';
import { pickLiveBrowserTabs, touchRecentBrowserTab } from '@/lib/browser/liveTabs';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { useGuestsStore } from '@/lib/guests/store';
import { guestHasSharedSurface, guestSurfaceDocking, type GuestSurfaceDocking } from '@/lib/guests/surfaces';
import { GUEST_SURFACE_DOCK_SIZE_MIN } from '@openchamber/sdk';
import { isPluginContextPanelMode, pluginIdFromMode, type PluginContextPanelMode } from '@/lib/surfaces/modes';
import {
  CHAT_NODE,
  leavesOf,
} from '@/lib/workspace/layoutTree';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';
import { clampContextEditorTreeWidth, normalizeContextPanelDirectoryKey, useUIStore, type ContextPanelTab, type PendingDiffScope } from '@/stores/useUIStore';
import { markSessionViewed } from '@/sync/notification-store';
import { setExternallyViewedSession } from '@/sync/sync-context';
import { ContextPanelHeaderSlotProvider } from './contextPanelHeaderSlot';
import { getSessionIDFromDedupeKey } from './contextPanelSessionTitles';
import { MovablePane } from './MovablePane';
import { SidebarFilesTree } from './SidebarFilesTree';
import { closeZoneOnEscape } from './zoneEscape';
import { usePaneHostsStore } from './regionHosts';
import { PauseClock } from '@/components/ui/pause-clock';
import { useDebuggerSurfaceReveal } from '@/lib/debugger/useDebuggerSurfaceReveal';

// Heavy views stay on-demand (same as MainLayout): importing DiffView/FilesView
// or the walkthrough statically pulls the CodeMirror and @pierre/diffs stacks
// into the eager startup graph even when no such tab is open.
const WalkthroughView = lazyWithChunkRecovery(() => import('@/components/views/walkthrough/WalkthroughView').then((m) => ({ default: m.WalkthroughView })));
const DiffView = lazyWithChunkRecovery(() => import('@/components/views/DiffView').then((m) => ({ default: m.DiffView })));
const FilesView = lazyWithChunkRecovery(() => import('@/components/views/FilesView').then((m) => ({ default: m.FilesView })));
const SourceBoardPane = lazyWithChunkRecovery(() => import('@/components/sourceBoard/SourceBoardView').then((m) => ({ default: m.SourceBoardPane })));
const McpConsolePane = lazyWithChunkRecovery(() => import('@/components/mcp/McpConsolePane').then((m) => ({ default: m.McpConsolePane })));
const PluginPane = React.lazy(() => import('./PluginPane').then((module) => ({ default: module.PluginPane })));
const GuestSurfacePane = React.lazy(() => import('./GuestSurfacePane').then((module) => ({ default: module.GuestSurfacePane })));

// How an extension page sits beside its shared surface: flex direction puts
// the page first on top/left and last on bottom/right; the page's size is
// fixed across the docked edge and the picture takes the rest.
const DOCK_LAYOUT = {
  top: { container: 'flex-col', page: 'border-b border-border', vertical: true },
  bottom: { container: 'flex-col-reverse', page: 'border-t border-border', vertical: true },
  left: { container: 'flex-row', page: 'border-e border-border', vertical: false },
  right: { container: 'flex-row-reverse', page: 'border-s border-border', vertical: false },
} as const;

/**
 * A shared-surface extension's own page, docked to one edge of the picture.
 * It starts at the manifest's `panel.size` and follows the page's
 * `host.setHeight` after that (the thickness across its edge, so a width
 * for a left or right dock), never below the manifest minimum and never past
 * half the panel, so the picture always stays in view.
 */
const DockedGuestPage: React.FC<{ mode: PluginContextPanelMode; docking: GuestSurfaceDocking }> = ({ mode, docking }) => {
  const [requested, setRequested] = React.useState<number | null>(null);
  const layout = DOCK_LAYOUT[docking.dock];
  const size = Math.max(GUEST_SURFACE_DOCK_SIZE_MIN, requested ?? docking.size);
  return (
    <div
      className={cn(
        'shrink-0 overflow-hidden duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
        layout.vertical ? 'max-h-[50%] transition-[height]' : 'max-w-[50%] transition-[width]',
        layout.page,
      )}
      style={layout.vertical ? { height: size } : { width: size }}
    >
      <PluginPane mode={mode} onResize={setRequested} />
    </div>
  );
};

/** A browser tab with the project it belongs to, which may not be the one on screen. */
type PanelBrowserTab = {
  directory: string;
  id: string;
  targetPath: string | null;
  ownerSessionId: string | null;
};

/** One browser tab across projects: the same id in another project is another tab. */
const browserTabRenderKey = (directory: string, tabId: string): string => `${directory}\u0000${tabId}`;

// The editor surface's file-tree column: docked on the side the user picked
// (`fileTreeSide`, left by default), resizable from the edge that faces the
// editor, and animated open/closed like the app sidebars. In tree-only mode
// (`fill`), the panel collapses around this fixed-width column, aligned to
// its side.
const EditorTreeColumn: React.FC<{ visible: boolean; active: boolean; fill?: boolean; side: 'left' | 'right' }> = ({ visible, active, fill = false, side }) => {
  const { t } = useI18n();
  const width = useUIStore((state) => state.contextEditorTreeWidth);
  const setWidth = useUIStore((state) => state.setContextEditorTreeWidth);
  const [isResizing, setIsResizing] = React.useState(false);
  const startXRef = React.useRef(0);
  const startWidthRef = React.useRef(width);
  const liveWidthRef = React.useRef<number | null>(null);
  const pointerIDRef = React.useRef<number | null>(null);
  const columnRef = React.useRef<HTMLDivElement | null>(null);

  const applyLiveTreeWidth = React.useCallback((nextWidth: number) => {
    const column = columnRef.current;
    if (!column) {
      return;
    }
    column.style.width = `${nextWidth}px`;
    column.style.setProperty('--oc-editor-tree-width', `${nextWidth}px`);
  }, []);

  const handlePointerDown = (event: React.PointerEvent) => {
    if (!visible) {
      return;
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // ignore
    }
    pointerIDRef.current = event.pointerId;
    setIsResizing(true);
    startXRef.current = event.clientX;
    startWidthRef.current = width;
    liveWidthRef.current = width;
    event.preventDefault();
  };

  const handlePointerMove = (event: React.PointerEvent) => {
    if (!isResizing || pointerIDRef.current !== event.pointerId) {
      return;
    }
    // The column grows away from its side's edge, toward the editor; in RTL
    // the sides are mirrored, so the same drag means the opposite change.
    const towardEditor = side === 'left' ? event.clientX - startXRef.current : startXRef.current - event.clientX;
    const delta = isRightToLeft(event.currentTarget) ? -towardEditor : towardEditor;
    const nextWidth = clampContextEditorTreeWidth(startWidthRef.current + delta);
    if (liveWidthRef.current === nextWidth) {
      return;
    }
    liveWidthRef.current = nextWidth;
    applyLiveTreeWidth(nextWidth);
  };

  const handlePointerEnd = (event: React.PointerEvent) => {
    if (pointerIDRef.current !== event.pointerId) {
      return;
    }
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // ignore
    }
    const finalWidth = clampContextEditorTreeWidth(liveWidthRef.current ?? width);
    pointerIDRef.current = null;
    liveWidthRef.current = null;
    setIsResizing(false);
    setWidth(finalWidth);
  };

  const appliedWidth = visible ? width : 0;

  return (
    <div
      ref={columnRef}
      className={cn(
        'relative h-full flex-shrink-0 overflow-hidden bg-background will-change-[width] motion-reduce:transition-none',
        fill && (side === 'left' ? 'me-auto' : 'ms-auto'),
      )}
      style={{
        width: `${isResizing ? (liveWidthRef.current ?? appliedWidth) : appliedWidth}px`,
        maxWidth: fill ? '100%' : undefined,
        ['--oc-editor-tree-width' as string]: `${isResizing ? (liveWidthRef.current ?? width) : width}px`,
        overflowX: 'clip',
        transitionProperty: isResizing ? 'none' : 'width',
        transitionDuration: '200ms',
        transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
      }}
      aria-hidden={!visible}
    >
      {/* Paint the divider without shifting tree content when the editor closes. */}
      {visible && !fill && (
        <div aria-hidden="true" className={cn('pointer-events-none absolute inset-y-0 z-20 w-px bg-border', side === 'left' ? 'inset-e-0' : 'inset-s-0')} />
      )}
      {visible && !fill && (
        <div
          className={cn(
            'absolute top-0 z-20 h-full w-[3px] cursor-col-resize transition-colors hover:bg-[var(--interactive-border)]/80',
            side === 'left' ? 'inset-e-0' : 'inset-s-0',
            isResizing && 'bg-[var(--interactive-border)]'
          )}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
          role="separator"
          aria-orientation="vertical"
          aria-label={t('contextPanel.actions.resizePanelAria')}
        />
      )}
      <div
        className={cn(
          'relative z-10 h-full shrink-0 transition-opacity duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
          isResizing && 'pointer-events-none',
          !visible && 'pointer-events-none select-none opacity-0'
        )}
        style={{ width: 'var(--oc-editor-tree-width)', maxWidth: fill ? '100%' : undefined }}
        aria-hidden={!visible}
      >
        <SidebarFilesTree visible={visible && active} />
      </div>
    </div>
  );
};

/**
 * A keep-alive pane: portalled into its zone's body, with the zone's Escape.
 * Its React events do not pass through the zone frame, so it closes the zone
 * itself.
 */
const RegionPane: React.FC<{
  hostKey: string | null;
  /** Whether the pane's tab is the one its region shows. */
  visible: boolean;
  directoryKey: string;
  className?: string;
  children: React.ReactNode;
}> = ({ hostKey, visible, directoryKey, className, children }) => {
  const closeLayoutRegion = useUIStore((state) => state.closeLayoutRegion);
  const handleKeyDownCapture = React.useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    closeZoneOnEscape(event, visible, () => {
      if (directoryKey && hostKey) closeLayoutRegion(directoryKey, hostKey);
    }, event.currentTarget.closest('[data-context-panel]'));
  }, [closeLayoutRegion, directoryKey, hostKey, visible]);
  return (
    <MovablePane hostKey={hostKey}>
      <div className={className} onKeyDownCapture={handleKeyDownCapture}>
        {children}
      </div>
    </MovablePane>
  );
};

/**
 * One regional chat, in the leaf that holds its tab. Every region carries its
 * own conversation: a review beside the session it reviews, two forks of one
 * task side by side. The pane is pinned to the tab's session and marks that
 * session viewed while its region shows it.
 */
const ChatRegionPane: React.FC<{
  tab: ContextPanelTab;
  hostKey: string | null;
  directoryKey: string;
}> = ({ tab, hostKey, directoryKey }) => {
  const { t } = useI18n();
  const sessionID = getSessionIDFromDedupeKey(tab.dedupeKey);
  // A chat opened from another project (or Chat) carries its own directory;
  // tabs opened without one (subtasks, reviews) belong to this panel's.
  const sessionDirectory = React.useMemo(() => {
    const own = tab.targetDirectory ? normalizeContextPanelDirectoryKey(tab.targetDirectory) : '';
    return own || directoryKey || null;
  }, [directoryKey, tab.targetDirectory]);
  const pinnedSession = React.useMemo(
    () => (sessionID ? { sessionId: sessionID, directory: sessionDirectory } : null),
    [sessionDirectory, sessionID],
  );

  React.useEffect(() => {
    if (!sessionDirectory || !sessionID || typeof window === 'undefined') {
      return;
    }

    const markChatViewed = () => {
      if (document.visibilityState === 'hidden' || !document.hasFocus()) {
        setExternallyViewedSession(sessionDirectory, sessionID, false);
        return;
      }

      markSessionViewed(sessionID);
      setExternallyViewedSession(sessionDirectory, sessionID, true);
    };

    markChatViewed();
    const interval = window.setInterval(markChatViewed, 10_000);
    window.addEventListener('focus', markChatViewed);
    window.addEventListener('blur', markChatViewed);
    document.addEventListener('visibilitychange', markChatViewed);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', markChatViewed);
      window.removeEventListener('blur', markChatViewed);
      document.removeEventListener('visibilitychange', markChatViewed);
      setExternallyViewedSession(sessionDirectory, sessionID, false);
    };
  }, [sessionDirectory, sessionID]);

  if (!pinnedSession) return null;
  return (
    <RegionPane hostKey={hostKey} visible directoryKey={directoryKey} className="absolute inset-0 bg-background">
      <section
        aria-label={t('contextPanel.iframe.sessionChatTitle', { sessionID })}
        className="h-full"
      >
        <ChatView
          pinnedSession={pinnedSession}
          readOnly={tab.readOnly}
        />
      </section>
    </RegionPane>
  );
};

/**
 * One regional file editor, in the region whose strip shows its tab. Every
 * region carries its own file — the same editor cannot: it would show the
 * one shared selection in both. The pane stays mounted while its tab exists,
 * hidden and detached when no region shows it, because the editor's unsaved
 * draft lives on the instance and must survive a region switch.
 */
const FileRegionPane: React.FC<{
  tab: ContextPanelTab;
  /** The region that holds the tab shows it; a restorable tab's pane parks hidden. */
  shown: boolean;
  hostKey: string | null;
  directoryKey: string;
  spacePreparing: boolean;
  onCloseFile: (filePath: string) => void;
}> = ({ tab, shown, hostKey, directoryKey, spacePreparing, onCloseFile }) => {
  const { t } = useI18n();
  const contextEditorTreeVisible = useUIStore((state) => state.contextEditorTreeVisible);
  const contextEditorVisible = useUIStore((state) => state.contextEditorVisible);
  const fileTreeSide = useUIStore((state) => state.fileTreeSide);
  const filePath = tab.targetPath ?? null;
  // The editor column is shown for an open file unless the user hid it; the
  // tree never hides alongside it, so a hidden tree forces the editor back.
  const showsEditor = filePath != null && (contextEditorVisible || !contextEditorTreeVisible);
  return (
    <RegionPane
      hostKey={shown ? hostKey : null}
      visible={shown}
      directoryKey={directoryKey}
      className={cn('absolute inset-0 flex', fileTreeSide === 'left' && 'flex-row-reverse', shown ? 'flex' : 'hidden')}
    >
      {spacePreparing ? (
        <div className="h-full min-w-0 flex-1"><SpacePreparing /></div>
      ) : filePath != null || !contextEditorTreeVisible ? (
        // Hidden rather than unmounted so a hidden editor keeps its state.
        <div className={cn('h-full min-w-0 flex-1', filePath != null && !showsEditor && 'hidden')}>
          {filePath != null ? (
            <React.Suspense fallback={null}>
              <FilesView
                mode="editor-only"
                pinnedPath={filePath}
                visible={shown && showsEditor}
                onCloseFile={onCloseFile}
              />
            </React.Suspense>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
              <Icon name="file-code" className="h-12 w-12 text-muted-foreground/50" />
              <div className="typography-ui-header text-foreground">{t('contextPanel.editorEmpty.title')}</div>
              <div className="max-w-sm typography-micro text-muted-foreground">{t('contextPanel.editorEmpty.description')}</div>
            </div>
          )}
        </div>
      ) : null}
      {/* The tree column only mounts where a region shows the file: the
          expansion state lives in the store, so a remounted tree reopens
          exactly where it was, and parked panes cost no directory listings.
          What a remount does lose is the tree's own UX state (search,
          scroll, cached listings): leaving a region for a chat and back
          re-reads the directories. */}
      {shown && !spacePreparing ? (
        <EditorTreeColumn visible={contextEditorTreeVisible} active={shown} fill={!showsEditor} side={fileTreeSide} />
      ) : null}
    </RegionPane>
  );
};

/**
 * Every keep-alive context surface, mounted once for the whole layout and
 * placed into the zone its surface lives in (`MovablePane`). The zone frames
 * (`ContextPanel`) render their chrome and the surfaces that remount on
 * switch (git, notes, plan, ...); these hold state a remount would lose.
 *
 * Rendered after every zone frame: the frames register their bodies from
 * refs and begin their layout animation in layout effects, both of which have
 * to run before the panes attach and the settle step queues behind them.
 */
export const ContextSurfacePanes: React.FC = () => {
  const effectiveDirectory = useEffectiveDirectory() ?? '';
  const directoryKey = React.useMemo(
    () => (effectiveDirectory ? normalizeContextPanelDirectoryKey(effectiveDirectory) : ''),
    [effectiveDirectory],
  );
  // A debugger run started from outside the panel — a chat request — joins
  // the layout here: ContextSurfacePanes is mounted once, whatever surface
  // the project shows.
  useDebuggerSurfaceReveal(directoryKey);
  const panelState = useUIStore((state) => (directoryKey ? state.contextPanelByDirectory[directoryKey] : undefined));
  // A draft waiting for a new space keeps its tabs here, under the project's folder, while what they
  // show comes from the space: nothing while the space is made, the space once it runs.
  const draftSpace = useDraftSpaceTarget();
  const spacePreparing = draftSpace?.kind === 'preparing';
  const draftSpaceDirectory = draftSpace?.kind === 'ready' ? draftSpace.directory : null;
  const contentDirectory = panelContentDirectory(draftSpace, effectiveDirectory) ?? '';
  const contextPanelByDirectory = useUIStore((state) => state.contextPanelByDirectory);
  const closeContextPanelTab = useUIStore((state) => state.closeContextPanelTab);
  const closeContextFile = useUIStore((state) => state.closeContextFile);
  const openContextPanelTab = useUIStore((state) => state.openContextPanelTab);
  const openAgentBrowserTab = useUIStore((state) => state.openAgentBrowserTab);
  const openContextFile = useUIStore((state) => state.openContextFile);
  const setSelectedFilePath = useFilesViewTabsStore((state) => state.setSelectedPath);
  const regionHosts = usePaneHostsStore((state) => state.byKey);

  const tabs = React.useMemo(() => panelState?.tabs ?? [], [panelState?.tabs]);
  const layout = panelState?.layout ?? CHAT_NODE;

  // Where each keep-alive tab lives: the region leaf that holds it, and
  // whether its region shows it. The strip is the truth; a tab whose leaf
  // was cut keeps its pane mounted nowhere until it opens again.
  const leafOfTab = React.useCallback(
    (tabId: string) => leavesOf(layout).find((leaf) => leaf.tabs.includes(tabId)) ?? null,
    [layout],
  );
  const shownInRegion = React.useCallback(
    (tabId: string) => leafOfTab(tabId)?.activeTabId === tabId,
    [leafOfTab],
  );

  // A browser tab loads its page only once it is needed: shown in an open
  // zone, opened by the agent, or woken by an agent action. Tabs restored
  // from a previous run otherwise stay asleep, since every loaded tab costs a
  // Chromium process. An agent's tab stays loaded until it is closed; the
  // user's own tabs, in every project together, keep their page only while
  // among the `liveBrowserTabLimit` most recently used (`liveTabs.ts`).
  const [recentBrowserTabs, setRecentBrowserTabs] = React.useState<readonly string[]>([]);
  const wakeBrowserTab = React.useCallback((directory: string, tabId: string) => {
    setRecentBrowserTabs((current) => touchRecentBrowserTab(current, browserTabRenderKey(directory, tabId)));
  }, []);
  const liveBrowserTabLimit = useUIStore((state) => state.liveBrowserTabLimit);

  // Lets an agent's browser.open create its own tab; the id goes back to the
  // agent so it keeps working there. Registered here because opening a tab is panel state, not
  // something the browser view itself can do before it exists. Background on
  // purpose: an agent working a page must not pop the panel open or steal the
  // active tab while the user reads something else, and that includes taking
  // a screenshot of it. The tab appears in the strip of the calling session's
  // project, which is not always the project on screen, and belongs to that
  // session.
  React.useEffect(() => registerBrowserOpener((url, context) => {
    const directory = context.directory ? normalizeContextPanelDirectoryKey(context.directory) : directoryKey;
    if (!directory) return null;
    const tabId = openAgentBrowserTab(directory, url, context.sessionId);
    if (tabId) wakeBrowserTab(directory, tabId);
    return tabId;
  }), [directoryKey, openAgentBrowserTab, wakeBrowserTab]);
  // Lets an agent close a tab it opened. controlClient has already checked the
  // tab belongs to the calling session; this only performs the panel close, so
  // the strip, the zone, and the webview process all settle the way a click on
  // the tab's own close button does.
  React.useEffect(() => registerBrowserCloser((directory, tabId) => {
    const tabs = useUIStore.getState().contextPanelByDirectory[directory]?.tabs;
    if (!tabs?.some((tab) => tab.id === tabId && tab.mode === 'browser')) return false;
    closeContextPanelTab(directory, tabId);
    return true;
  }), [closeContextPanelTab]);
  // The agent asked for a file to be shown. It opens in front of whatever tab
  // the user had, on purpose: the agent is pointing at a result, and the prior
  // tab is one click away.
  React.useEffect(() => subscribeOpenchamberEvents((event) => {
    if (event.type !== 'file-open-request') return;
    const directory = event.directory ?? effectiveDirectory;
    if (!directory) return;
    openContextFile(directory, event.path);
  }), [effectiveDirectory, openContextFile]);
  // The agent asked for a saved plan to be shown: it opens in place in the
  // Project knowledge panel, as a click in its Plans list does, in the strip
  // of the asking session's project.
  React.useEffect(() => subscribeOpenchamberEvents((event) => {
    if (event.type !== 'plan-open-request') return;
    const directory = event.directory ?? effectiveDirectory;
    const projectRef = resolvePlanRequestOwner(directory, event.projectId);
    if (!directory || !projectRef) return;
    useUIStore.getState().openProjectKnowledgePlan(directory, resolveProjectContextId(projectRef), event.planId);
  }), [effectiveDirectory]);

  // Tells agent browser control which project is on screen and which browser
  // tab the user last had in front of them there; a session without a tab of
  // its own may use that tab only when it is the user's and in its project.
  const shownBrowserTabId = React.useMemo(
    () => tabs.find((tab) => tab.mode === 'browser' && shownInRegion(tab.id))?.id ?? null,
    [shownInRegion, tabs],
  );
  React.useEffect(() => {
    setShownBrowserTab(directoryKey, shownBrowserTabId);
  }, [directoryKey, shownBrowserTabId]);

  const fileActiveTab = React.useMemo(
    () => tabs.find((tab) => tab.mode === 'file' && shownInRegion(tab.id)) ?? null,
    [shownInRegion, tabs],
  );
  React.useEffect(() => {
    if (!contentDirectory || fileActiveTab?.mode !== 'file' || !fileActiveTab.targetPath) {
      return;
    }
    // The editor reads its file under the folder the panel shows. A draft waiting for a space
    // shows only the space's files, so a tab opened on this computer's before stays empty; and a
    // tab the draft opened in the space stays empty in the project's other chats.
    const sameSide = spaceIdOfDirectory(fileActiveTab.targetPath) === spaceIdOfDirectory(contentDirectory);
    setSelectedFilePath(normalizeContextPanelDirectoryKey(contentDirectory), fileActiveTab.targetPath, { allowOutsideRoot: !draftSpace && sameSide });
  }, [contentDirectory, draftSpace, fileActiveTab, setSelectedFilePath]);

  // Every file tab keeps its own pane: two regions show two files, each
  // editor pinned to its tab's path. A restorable tab (not shown in any
  // region) keeps its pane mounted and parked hidden, because the editor's
  // unsaved draft lives on the instance.
  const fileTabs = React.useMemo(() => tabs.filter((tab) => tab.mode === 'file'), [tabs]);

  // The editor's Cmd/Ctrl+W and its unsaved-changes prompt close the file's
  // tab here, so the strip and the next file follow as with the close button.
  const handleCloseEditorFile = React.useCallback((filePath: string) => {
    if (directoryKey) closeContextFile(directoryKey, filePath);
  }, [closeContextFile, directoryKey]);

  // The chat tabs their regions show: one pane per region, so two forks of
  // one task sit side by side.
  const chatShownTabs = React.useMemo(
    () => tabs.filter((tab) => tab.mode === 'chat' && shownInRegion(tab.id)),
    [shownInRegion, tabs],
  );

  // The diff tab its region shows; the header slot follows the visible one.
  const diffActiveTab = React.useMemo(
    () => tabs.find((tab) => tab.mode === 'diff' && shownInRegion(tab.id)) ?? null,
    [shownInRegion, tabs],
  );
  const handleDiffScopeChange = React.useCallback((nextScope: PendingDiffScope) => {
    if (!directoryKey || diffActiveTab?.mode !== 'diff') {
      return;
    }

    openContextPanelTab(directoryKey, {
      mode: 'diff',
      targetPath: diffActiveTab.targetPath,
      targetDirectory: diffActiveTab.targetDirectory,
      stagedDiff: nextScope === 'staged',
      diffScope: nextScope,
    });
  }, [diffActiveTab, directoryKey, openContextPanelTab]);

  const visibleBrowserTabId = shownBrowserTabId;
  React.useEffect(() => {
    if (visibleBrowserTabId && directoryKey) wakeBrowserTab(directoryKey, visibleBrowserTabId);
  }, [directoryKey, visibleBrowserTabId, wakeBrowserTab]);
  // The browser tabs agents can reach: this project's, and every other
  // project's agent tabs, so a session working in a project the user is not
  // looking at keeps its page. The user's own tabs in other projects stay
  // loaded while among the most recently used, and are left out otherwise.
  // Sorted by directory and tab id, an order that neither the project on
  // screen nor the store's own reordering of directories can change: a moved
  // webview reloads its page.
  const { loadedBrowserTabs, sleepingBrowserTabs } = React.useMemo(() => {
    const recent = new Set(recentBrowserTabs);
    const openUserTabs = new Set<string>();
    for (const [directory, directoryState] of Object.entries(contextPanelByDirectory)) {
      for (const tab of directoryState.tabs) {
        if (tab.mode === 'browser' && tab.ownerSessionId === null) openUserTabs.add(browserTabRenderKey(directory, tab.id));
      }
    }
    const liveUserTabs = pickLiveBrowserTabs(recentBrowserTabs, openUserTabs, liveBrowserTabLimit);
    const loaded: PanelBrowserTab[] = [];
    const sleeping: PanelBrowserTab[] = [];
    for (const [directory, directoryState] of Object.entries(contextPanelByDirectory)) {
      const isShownDirectory = directory === directoryKey;
      for (const tab of directoryState.tabs) {
        if (tab.mode !== 'browser') continue;
        const key = browserTabRenderKey(directory, tab.id);
        const isUserTab = tab.ownerSessionId === null;
        const isLoaded = (isShownDirectory && tab.id === visibleBrowserTabId)
          || (isUserTab ? liveUserTabs.has(key) : recent.has(key));
        if (!isLoaded && !isShownDirectory && isUserTab) continue;
        const entry = { directory, id: tab.id, targetPath: tab.targetPath, ownerSessionId: tab.ownerSessionId };
        (isLoaded ? loaded : sleeping).push(entry);
      }
    }
    loaded.sort((a, b) => (browserTabRenderKey(a.directory, a.id) < browserTabRenderKey(b.directory, b.id) ? -1 : 1));
    return { loadedBrowserTabs: loaded, sleepingBrowserTabs: sleeping };
  }, [contextPanelByDirectory, directoryKey, liveBrowserTabLimit, recentBrowserTabs, visibleBrowserTabId]);
  React.useEffect(() => {
    // Only a Chromium host mounts views that agents can drive, so only it may
    // offer to wake a tab; anywhere else a claimed action could never run.
    if (!window.__OPENCHAMBER_ELECTRON__) return;
    const unregister = sleepingBrowserTabs.map((tab) => registerSleepingBrowserTab({
      tabId: tab.id,
      directory: tab.directory,
      ownerSessionId: tab.ownerSessionId,
      describe: () => ({ title: '', url: tab.targetPath ?? '' }),
      wake: () => wakeBrowserTab(tab.directory, tab.id),
    }));
    return () => unregister.forEach((release) => release());
  }, [sleepingBrowserTabs, wakeBrowserTab]);

  const diffTabs = React.useMemo(() => tabs.filter((tab) => tab.mode === 'diff'), [tabs]);
  const terminalTab = React.useMemo(
    () => tabs.find((tab) => tab.mode === 'terminal') ?? null,
    [tabs],
  );
  const debugTab = React.useMemo(
    () => tabs.find((tab) => tab.mode === 'debug') ?? null,
    [tabs],
  );
  const boardTab = React.useMemo(
    () => tabs.find((tab) => tab.mode === 'board') ?? null,
    [tabs],
  );
  const mcpConsoleTab = React.useMemo(
    () => tabs.find((tab) => tab.mode === 'mcp-console') ?? null,
    [tabs],
  );
  // Keep-alive: the walkthrough holds reading progress and scroll position that
  // a remount would silently throw away.
  const hasWalkthroughTab = React.useMemo(() => tabs.some((tab) => tab.mode === 'walkthrough'), [tabs]);
  const walkthroughActiveTab = React.useMemo(
    () => tabs.find((tab) => tab.mode === 'walkthrough' && shownInRegion(tab.id)) ?? null,
    [shownInRegion, tabs],
  );
  const pluginTabs = React.useMemo(() => tabs.filter((tab) => isPluginContextPanelMode(tab.mode)), [tabs]);
  const guests = useGuestsStore((state) => state.guests);
  const surfaceGuestIds = React.useMemo(
    () => new Set(guests.filter(guestHasSharedSurface).map((guest) => guest.id)),
    [guests],
  );
  // Surface extensions that also ship a page: it is docked to one edge of the picture.
  const surfaceDockings = React.useMemo(() => {
    const dockings = new Map<string, GuestSurfaceDocking>();
    for (const guest of guests) {
      const docking = guestSurfaceDocking(guest);
      if (docking) dockings.set(guest.id, docking);
    }
    return dockings;
  }, [guests]);

  // A terminal tab dragged out of the terminal's own strip moves the terminal.
  // The header slot goes to the pane whose region shows it, and only while
  // shown: a hidden surface's toolbar must not answer for the region.
  const headerSlotFor = (leafId: string | null, active: boolean): HTMLElement | null =>
    (active && leafId ? regionHosts[leafId]?.headerSlot ?? null : null);

  return (
    <>
      {fileTabs.map((tab) => (
        <FileRegionPane
          key={tab.id}
          tab={tab}
          shown={shownInRegion(tab.id)}
          hostKey={leafOfTab(tab.id)?.id ?? null}
          directoryKey={directoryKey}
          spacePreparing={spacePreparing}
          onCloseFile={handleCloseEditorFile}
        />
      ))}
      {chatShownTabs.map((tab) => (
        <ChatRegionPane
          key={tab.id}
          tab={tab}
          hostKey={leafOfTab(tab.id)?.id ?? null}
          directoryKey={directoryKey}
        />
      ))}
      {loadedBrowserTabs.map((tab) => {
        const shown = tab.directory === directoryKey && shownInRegion(tab.id);
        // A tab of the draft on screen browses the space it waits for once the space runs.
        const siteDirectory = tab.directory === directoryKey ? draftSpaceDirectory ?? tab.directory : tab.directory;
        return (
          <RegionPane
            // Keyed by the directory as well: a tab of the next directory with the
            // same id is another tab, with its own view and its own session. Kept
            // on the same instance, the view went on showing the previous
            // directory's page, and a space's page would run in the host's
            // session instead of the space's own.
            key={browserTabRenderKey(tab.directory, tab.id)}
            hostKey={tab.directory === directoryKey ? leafOfTab(tab.id)?.id ?? null : null}
            visible={shown}
            directoryKey={directoryKey}
            // Invisible rather than display:none, so a background tab the agent
            // is working keeps its layout and its snapshots read a real page.
            className={cn('absolute inset-0', !shown && 'invisible pointer-events-none')}
          >
            <div className="h-full" aria-hidden={!shown || undefined}>
              <PauseClock paused={!shown}>
              {tab.directory === directoryKey && spacePreparing ? <SpacePreparing /> : (
                <BrowserPane
                  // Remounted when the space starts: its page runs in the space's own session.
                  key={siteDirectory}
                  initialUrl={tab.targetPath ?? ''}
                  directory={tab.directory}
                  siteDirectory={siteDirectory}
                  tabID={tab.id}
                  ownerSessionId={tab.ownerSessionId}
                  visible={shown}
                />
              )}
              </PauseClock>
            </div>
          </RegionPane>
        );
      })}
      {diffTabs.map((tab) => {
        const active = shownInRegion(tab.id);
        return (
          <RegionPane
            key={tab.id}
            hostKey={leafOfTab(tab.id)?.id ?? null}
            visible={active}
            directoryKey={directoryKey}
            className={cn('absolute inset-0', !active && 'hidden')}
          >
            <React.Suspense fallback={null}>
              <ContextPanelHeaderSlotProvider value={headerSlotFor(leafOfTab(tab.id)?.id ?? null, active)}>
                {spacePreparing && !tab.targetDirectory ? <SpacePreparing /> : <DiffView
                  directory={tab.targetDirectory ?? draftSpaceDirectory}
                  visible={active}
                  hideStackedFileSidebar
                  stackedDefaultCollapsedAll
                  pinSelectedFileHeaderToTopOnNavigate
                  showOpenInEditorAction
                  diffScope={tab.diffScope ?? (tab.stagedDiff ? 'staged' : null)}
                  onDiffScopeChange={handleDiffScopeChange}
                  targetFilePath={tab.targetPath}
                  flushContent
                />}
              </ContextPanelHeaderSlotProvider>
            </React.Suspense>
          </RegionPane>
        );
      })}
      {terminalTab ? (
        <RegionPane
          hostKey={leafOfTab(terminalTab.id)?.id ?? null}
          visible={shownInRegion(terminalTab.id)}
          directoryKey={directoryKey}
          className={cn('absolute inset-0', shownInRegion(terminalTab.id) ? 'block' : 'hidden')}
        >
          <ContextPanelHeaderSlotProvider value={headerSlotFor(leafOfTab(terminalTab.id)?.id ?? null, shownInRegion(terminalTab.id))}>
            <TerminalView
              visible={shownInRegion(terminalTab.id)}
              directory={terminalTab.targetDirectory}
              onLastTabClosed={() => { if (directoryKey) closeContextPanelTab(directoryKey, terminalTab.id); }}
            />
          </ContextPanelHeaderSlotProvider>
        </RegionPane>
      ) : null}
      {debugTab ? (
        <RegionPane
          hostKey={leafOfTab(debugTab.id)?.id ?? null}
          visible={shownInRegion(debugTab.id)}
          directoryKey={directoryKey}
          className={cn('absolute inset-0', shownInRegion(debugTab.id) ? 'block' : 'hidden')}
        >
          <ContextPanelHeaderSlotProvider value={headerSlotFor(leafOfTab(debugTab.id)?.id ?? null, shownInRegion(debugTab.id))}>
            <DebugView
              visible={shownInRegion(debugTab.id)}
              directory={debugTab.targetDirectory}
            />
          </ContextPanelHeaderSlotProvider>
        </RegionPane>
      ) : null}
      {boardTab ? (
        // The board as a keep-alive region pane: its scroll and preview
        // choice survive a switch, and its data refreshes only while a
        // region shows it.
        <RegionPane
          hostKey={leafOfTab(boardTab.id)?.id ?? null}
          visible={shownInRegion(boardTab.id)}
          directoryKey={directoryKey}
          className={cn('absolute inset-0', shownInRegion(boardTab.id) ? 'block' : 'hidden')}
        >
          <React.Suspense fallback={null}>
            <SourceBoardPane visible={shownInRegion(boardTab.id)} />
          </React.Suspense>
        </RegionPane>
      ) : null}
      {mcpConsoleTab ? (
        // The MCP console as a keep-alive region pane: a tool run's answer
        // and the form that asked for it survive a switch to another tab.
        <RegionPane
          hostKey={leafOfTab(mcpConsoleTab.id)?.id ?? null}
          visible={shownInRegion(mcpConsoleTab.id)}
          directoryKey={directoryKey}
          className={cn('absolute inset-0', shownInRegion(mcpConsoleTab.id) ? 'block' : 'hidden')}
        >
          <React.Suspense fallback={null}>
            <McpConsolePane visible={shownInRegion(mcpConsoleTab.id)} />
          </React.Suspense>
        </RegionPane>
      ) : null}
      {hasWalkthroughTab ? (
        <RegionPane
          hostKey={leafOfTab(walkthroughActiveTab?.id ?? '')?.id ?? null}
          visible={walkthroughActiveTab !== null}
          directoryKey={directoryKey}
          className={cn('absolute inset-0', walkthroughActiveTab ? 'block' : 'hidden')}
        >
          <React.Suspense fallback={null}>
            <ContextPanelHeaderSlotProvider value={headerSlotFor(walkthroughActiveTab ? leafOfTab(walkthroughActiveTab.id)?.id ?? null : null, walkthroughActiveTab !== null)}>
              <WalkthroughView directory={effectiveDirectory} visible={walkthroughActiveTab !== null} />
            </ContextPanelHeaderSlotProvider>
          </React.Suspense>
        </RegionPane>
      ) : null}
      {pluginTabs.map((tab) => {
        if (!isPluginContextPanelMode(tab.mode)) return null;
        // A shared-surface extension's picture is drawn by the host and
        // mounted only while shown, so an unwatched surface holds no socket
        // and its service can idle out. Its own page, when it has one, is
        // docked to one edge of the picture and stays mounted like any
        // panel iframe.
        const guestId = pluginIdFromMode(tab.mode);
        const sharedSurface = surfaceGuestIds.has(guestId);
        const docking = surfaceDockings.get(guestId);
        const shown = shownInRegion(tab.id);
        const surfaceMounted = shown;
        if (sharedSurface && !docking && !surfaceMounted) return null;
        return (
          <RegionPane
            key={tab.id}
            hostKey={leafOfTab(tab.id)?.id ?? null}
            visible={shown}
            directoryKey={directoryKey}
            className={cn('absolute inset-0', shown ? 'block' : 'hidden')}
          >
            <React.Suspense fallback={null}>
              {!sharedSurface ? (
                <PluginPane mode={tab.mode} />
              ) : !docking ? (
                <GuestSurfacePane mode={tab.mode} />
              ) : (
                <div className={cn('flex h-full', DOCK_LAYOUT[docking.dock].container)}>
                  <DockedGuestPage mode={tab.mode} docking={docking} />
                  <div className="min-h-0 min-w-0 flex-1">
                    {surfaceMounted ? <GuestSurfacePane mode={tab.mode} /> : null}
                  </div>
                </div>
              )}
            </React.Suspense>
          </RegionPane>
        );
      })}
    </>
  );
};
