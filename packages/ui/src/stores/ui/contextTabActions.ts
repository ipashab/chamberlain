import { directoryMayHaveActiveProjectAction, useTerminalStore } from '@/stores/useTerminalStore';
import { useFilesViewTabsStore } from '../useFilesViewTabsStore';
import { isVSCodeRuntime } from '@/lib/desktop';
import { noteBrowserTabOpenedWithAddress, requestBrowserTabLoad } from '@/lib/browser/devServerWait';
import { getZoneView, withZoneView, zoneOfMode } from '@/lib/workspace/zones';
import {
  CHAT_NODE,
  activateTab as activateTabInTree,
  findLeaf,
  leavesOf,
  openSurfaceInTree,
  sanitizeTree,
} from '@/lib/workspace/layoutTree';
import {
  DEFAULT_WORKSPACE_MODE,
  restorePresetRegions,
  workspaceModePreset,
} from '@/lib/workspace/modePresets';
import type { ContextPanelTab, ContextPanelDirectoryState, UIStore, UIStoreSlice } from './types';
import {
  normalizeDirectoryPath,
  normalizeContextTargetPath,
  normalizeContextTargetDirectory,
  contextPanelModeKeepsTargetDirectory,
  isTrackerBranchTab,
  normalizePendingDiffScope,
  buildContextPanelTabID,
} from './contextTabs';
import {
  touchContextPanelState,
  upsertContextPanelTab,
  closeContextPanelTabs,
  reorderContextPanelTabs,
  setContextPanelTabTargetPath,
  moveContextPanelFileTabs,
  clampContextPanelRoots,
} from './contextPanelState';

let browserTabSequence = 0;

const noteBrowserTabAddressRequested = (
  byDirectory: Record<string, ContextPanelDirectoryState>,
  directory: string,
  dedupeKey: string,
  url: string,
): void => {
  const tabID = buildContextPanelTabID('browser', dedupeKey);
  if (byDirectory[directory]?.tabs.some((tab) => tab.id === tabID)) {
    requestBrowserTabLoad(directory, tabID, url);
    return;
  }
  noteBrowserTabOpenedWithAddress(directory, tabID);
};

const openFileTab = (state: UIStore, directory: string, filePath: string, preview: boolean) => {
  const tabs = state.contextPanelByDirectory[directory]?.tabs ?? [];
  const replacedPreviewPath = preview
    ? tabs.find((tab) => tab.preview && tab.targetPath !== filePath)?.targetPath ?? null
    : null;
  const alreadyOpen = tabs.some((tab) => tab.mode === 'file' && tab.targetPath === filePath);
  state.openContextPanelTab(directory, { mode: 'file', targetPath: filePath, preview });
  if (replacedPreviewPath && !alreadyOpen) {
    useFilesViewTabsStore.getState().removeOpenPath(directory, replacedPreviewPath);
  }
};

export const createContextTabActions: UIStoreSlice<
  | 'openContextSurface'
  | 'openContextPanelTab'
  | 'openTrackerItem'
  | 'openContextDiff'
  | 'openContextFile'
  | 'openContextFileAtLine'
  | 'openContextOverview'
  | 'openContextPreview'
  | 'openAgentBrowserTab'
  | 'openNewContextBrowserTab'
  | 'openContextBrowser'
  | 'setContextPanelTabTargetPath'
  | 'moveContextFilePaths'
  | 'setActiveContextPanelTab'
  | 'reorderContextPanelTabs'
  | 'pinContextPanelTab'
  | 'closeContextPanelTab'
  | 'closeContextFile'
  | 'closeContextPanelTabs'
  | 'closeContextSurfaceTabs'
  | 'openContextSurfaceInLeaf'
  | 'openContextPanelTabToLeaf'
  | 'switchWorkspaceMode'
  | 'offerWorkspaceMode'
  | 'dismissWorkspaceModeOffer'
> = (set, get) => ({
  openContextSurface: (directory, mode) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    if (!normalizedDirectory) {
      return;
    }

    const state = get();
    const panelState = state.contextPanelByDirectory[normalizedDirectory];
    const tabs = panelState?.tabs ?? [];
    // Дерево решает, что на экране: поверхность, которую показывает область,
    // — это активная вкладка её листа. Клик по иконке поверхности в рельсе
    // закрывает область, в которой та показана, — её вкладки остаются
    // в ленте, живые для следующего открытия.
    let shownLeafId: string | null = null;
    for (const leaf of leavesOf(panelState?.layout ?? CHAT_NODE)) {
      const tab = tabs.find((entry) => entry.id === leaf.activeTabId);
      if (tab?.mode === mode) {
        shownLeafId = leaf.id;
        break;
      }
    }
    const clearTerminalTarget = () => {
      if (mode === 'terminal') {
        const terminalTab = tabs.find((tab) => tab.mode === 'terminal') ?? null;
        const targetDirectory = terminalTab?.targetDirectory ?? null;
        if (targetDirectory) {
          const targetState = useTerminalStore.getState().getDirectoryState(targetDirectory);
          if (directoryMayHaveActiveProjectAction(targetState)) {
            return;
          }
        }
        state.openContextPanelTab(normalizedDirectory, { mode: 'terminal', targetDirectory: null }, { reveal: false });
      }
    };

    if (shownLeafId !== null) {
      clearTerminalTarget();
      state.closeLayoutRegion(normalizedDirectory, shownLeafId);
      return;
    }

    if (mode === 'file' && !state.contextEditorTreeVisible
      && !tabs.some((tab) => tab.mode === 'file' && tab.targetPath)) {
      set({ contextEditorTreeVisible: true });
    }

    const tabsOfMode = tabs.filter((tab) => tab.mode === mode);
    if (tabsOfMode.length > 0) {
      clearTerminalTarget();
      const mostRecent = tabsOfMode.reduce((best, tab) => (tab.touchedAt >= best.touchedAt ? tab : best));
      if ((mode === 'diff' || mode === 'walkthrough') && mostRecent.targetDirectory) {
        state.openContextPanelTab(normalizedDirectory, {
          mode,
          targetPath: mostRecent.targetPath,
          stagedDiff: mostRecent.stagedDiff,
          diffScope: mostRecent.diffScope,
          targetDirectory: null,
        });
        return;
      }
      state.setActiveContextPanelTab(normalizedDirectory, mostRecent.id);
      return;
    }

    // Содержимо-управляемым режимам нужен payload (сессия для разбиения);
    // рельса рисует их выключенными, пока содержимого нет. 'file' открывает
    // пустой редактор, чьё встроенное дерево выберет первый файл.
    if (mode === 'chat' || mode === 'team') {
      return;
    }

    state.openContextPanelTab(normalizedDirectory, { mode });
  },

  openContextSurfaceInLeaf: (directory, mode, leafId) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    if (!normalizedDirectory) {
      return;
    }
    const state = get();
    const panelState = state.contextPanelByDirectory[normalizedDirectory];
    // Лист должен существовать: устаревшая явная цель (перезагрузка,
    // закрытая область) иначе молча выдумала бы форму дерева.
    if (!leavesOf(panelState?.layout ?? CHAT_NODE).some((leaf) => leaf.id === leafId)) {
      return;
    }
    const mostRecentOfMode = (tabsOfMode: ContextPanelTab[]) => (
      // `>=`, чтобы равные отметки времени (открытия в одну миллисекунду)
      // разрешались в более позднюю вкладку по порядку вставки.
      tabsOfMode.reduce((best, tab) => (tab.touchedAt >= best.touchedAt ? tab : best))
    );
    // Поверхность файлов приходит со своим списком: открытие её в лист,
    // из рельсы или при переключении режима, показывает приставленное
    // дерево, даже когда вкладка уже есть и меняется только её размещение.
    if (mode === 'file' && !state.contextEditorTreeVisible) {
      set({ contextEditorTreeVisible: true });
    }
    const existing = (panelState?.tabs ?? []).filter((tab) => tab.mode === mode);
    if (existing.length > 0) {
      // При существующей вкладке открывать нечего — решается только её
      // размещение. Именно поэтому выделенный в отдельную область чат или
      // дифф переезжает в пустую область, которую выбрал пользователь.
      const target = mostRecentOfMode(existing).id;
      state.moveContextPanelTabToLeaf(normalizedDirectory, target, leafId);
      return;
    }
    // Содержимо-управляемые режимы без вкладки остаются на месте: рельса
    // их и не предлагала бы. 'file' открывает пустой редактор.
    if (mode === 'chat' || mode === 'team') {
      return;
    }
    state.openContextPanelTab(normalizedDirectory, { mode });
    // Открытие только что создало единственную вкладку этого режима; переносим её.
    const openedTabs = (get().contextPanelByDirectory[normalizedDirectory]?.tabs ?? []).filter((tab) => tab.mode === mode);
    if (openedTabs.length > 0) {
      state.moveContextPanelTabToLeaf(normalizedDirectory, mostRecentOfMode(openedTabs).id, leafId);
    }
  },

  openContextPanelTabToLeaf: (directory, tab, leafId) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    if (!normalizedDirectory) {
      return;
    }
    const state = get();
    const panelState = state.contextPanelByDirectory[normalizedDirectory];
    // Лист должен существовать: устаревшая цель иначе молча уронила бы
    // вкладку туда, куда выбрали правила размещения.
    if (!leavesOf(panelState?.layout ?? CHAT_NODE).some((leaf) => leaf.id === leafId)) {
      return;
    }
    state.openContextPanelTab(normalizedDirectory, tab);
    // `openContextPanelTab` дедуплицируется на существующую вкладку той же
    // сессии; в лист встаёт именно она, а не свежая.
    const opened = (get().contextPanelByDirectory[normalizedDirectory]?.tabs ?? [])
      .find((entry) => entry.dedupeKey === tab.dedupeKey);
    if (opened) {
      state.moveContextPanelTabToLeaf(normalizedDirectory, opened.id, leafId);
    }
  },

  switchWorkspaceMode: (directory, mode) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    if (!normalizedDirectory) {
      return;
    }
    const state = get();
    // Переключение принимает любое видимое предложение без ещё одного клика.
    if (state.workspaceModeOffer) {
      set({ workspaceModeOffer: null });
    }
    const prev = touchContextPanelState(
      state.contextPanelByDirectory[normalizedDirectory],
      state.contextSurfaceZones,
    );
    // Полноэкранная поверхность (страница доски, запланированные задачи,
    // статистика) закрывает чат; режим показывает само рабочее пространство,
    // поэтому такие страницы закрываются первыми. Вызов с тем же режимом
    // остаётся, чтобы их закрыть.
    state.closeMainSurfaces();
    if (prev.workspaceMode === mode) {
      return;
    }

    // Ни разу не посещённый режим входит со своим пресетом; сохранённое
    // дерево возвращается таким, каким его оставил пользователь, с областями
    // режима, отстроенными там, где они были закрыты. В любом случае входящее
    // дерево чинится по живой ленте, так что вкладки покидают только те
    // листья, которые их держат.
    const preset = prev.modeLayouts[mode] ? null : workspaceModePreset(mode);
    const incomingLayout = restorePresetRegions(
      mode,
      sanitizeTree(
        prev.modeLayouts[mode] ?? preset?.tree ?? CHAT_NODE,
        new Set(prev.tabs.map((tab) => tab.id)),
      ),
    );

    set((state) => {
      const current = touchContextPanelState(
        state.contextPanelByDirectory[normalizedDirectory],
        state.contextSurfaceZones,
      );
      const modeLayouts = {
        ...current.modeLayouts,
        [current.workspaceMode]: current.layout,
      };
      delete modeLayouts[mode];
      return {
        contextPanelByDirectory: clampContextPanelRoots({
          ...state.contextPanelByDirectory,
          [normalizedDirectory]: {
            ...current,
            workspaceMode: mode,
            layout: incomingLayout,
            modeLayouts,
            touchedAt: Date.now(),
          },
        }, 20),
      };
    });

    // Пустой именованный лист заново берёт свою поверхность при каждом входе,
    // а не только при первом: лента вкладок общая, поэтому закрытие вкладки
    // файлов в режиме чата опустошает и лист редактора режима отладки, и
    // сохранённое дерево без ничего оставило бы режим без его области,
    // а пользователя — без пути назад. Лист, держащий любую вкладку,
    // остаётся как его расставил пользователь; область, за которую режим
    // отвечает, возвращается через `restorePresetRegions` выше.
    for (const open of workspaceModePreset(mode).opens) {
      const leaf = findLeaf(incomingLayout, open.leafId);
      if (leaf && leaf.tabs.length === 0) {
        state.openContextSurfaceInLeaf(normalizedDirectory, open.mode, open.leafId);
      }
    }
  },

  offerWorkspaceMode: (directory, mode, reason) => {
    const state = get();
    if (state.workspaceModeOffer || state.workspaceModeOfferDismissed.includes(reason)) {
      return;
    }
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    if (!normalizedDirectory || mode === 'chat') {
      return;
    }
    // Карточку получает только проект, всё ещё в дефолтном чате: проект,
    // уже работающий в другом режиме, расставил свою раскладку нарочно.
    if ((state.contextPanelByDirectory[normalizedDirectory]?.workspaceMode ?? DEFAULT_WORKSPACE_MODE) !== 'chat') {
      return;
    }
    set({ workspaceModeOffer: { directory: normalizedDirectory, mode, reason } });
  },

  dismissWorkspaceModeOffer: () => {
    set((state) => ({
      workspaceModeOffer: null,
      workspaceModeOfferDismissed: state.workspaceModeOffer
        ? [...state.workspaceModeOfferDismissed, state.workspaceModeOffer.reason]
        : state.workspaceModeOfferDismissed,
    }));
  },

  openContextPanelTab: (directory, tab, options) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    if (!normalizedDirectory) {
      return;
    }

    const nextTab = tab.mode !== 'chat' && contextPanelModeKeepsTargetDirectory(tab.mode)
      ? {
          ...tab,
          targetDirectory: normalizeContextTargetDirectory(tab.targetDirectory) === normalizedDirectory
            ? null
            : normalizeContextTargetDirectory(tab.targetDirectory),
        }
      : tab;

    const showsFile = nextTab.mode === 'file' && Boolean(nextTab.targetPath) && options?.reveal !== false;

    set((state) => {
      const prev = state.contextPanelByDirectory[normalizedDirectory];
      const current = touchContextPanelState(prev, state.contextSurfaceZones);
      const byDirectory = {
        ...state.contextPanelByDirectory,
        [normalizedDirectory]: upsertContextPanelTab(current, nextTab, state.contextSurfaceZones, options),
      };

      return {
        contextPanelByDirectory: clampContextPanelRoots(byDirectory, 20),
        contextEditorVisible: showsFile || state.contextEditorVisible,
      };
    });
  },

  openTrackerItem: (directory, item) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    const url = item.url.trim();
    if (!normalizedDirectory || !url) {
      return null;
    }

    const dedupeKey = `tracker:${item.key}`;
    const targetDirectory = normalizeContextTargetDirectory(item.targetDirectory);
    set((state) => {
      const placement = state.contextSurfaceZones;
      const current = touchContextPanelState(state.contextPanelByDirectory[normalizedDirectory], placement);
      const withBranch = current.tabs.some(isTrackerBranchTab)
        ? current
        : upsertContextPanelTab(current, { mode: 'pr' }, placement, { reveal: false });
      const byDirectory = {
        ...state.contextPanelByDirectory,
        [normalizedDirectory]: upsertContextPanelTab(withBranch, {
          mode: 'pr',
          targetPath: url,
          dedupeKey,
          label: item.label,
          targetDirectory: targetDirectory === normalizedDirectory ? null : targetDirectory,
        }, placement),
      };
      return { contextPanelByDirectory: clampContextPanelRoots(byDirectory, 20) };
    });
    // Элемент трекера, открытый из чата, — собственный предмет доски;
    // карточка подсказывает режим один раз и никогда не занимает экран сама.
    get().offerWorkspaceMode(normalizedDirectory, 'board', 'tracker-item');
    return buildContextPanelTabID('pr', dedupeKey);
  },

  openContextDiff: (directory, filePath, staged = false, scope = null) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    const normalizedFilePath = (filePath || '').trim();
    if (!normalizedDirectory || !normalizedFilePath) {
      return;
    }

    const diffScope = normalizePendingDiffScope(scope) ?? (staged ? 'staged' : 'working');

    get().openContextPanelTab(normalizedDirectory, {
      mode: 'diff',
      targetPath: normalizedFilePath,
      stagedDiff: diffScope === 'staged',
      diffScope,
    });
  },

  openContextFile: (directory, filePath, options) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    const normalizedFilePath = normalizeContextTargetPath(filePath);
    if (!normalizedDirectory || !normalizedFilePath) {
      return;
    }

    openFileTab(get(), normalizedDirectory, normalizedFilePath, options?.preview === true);
    get().setPendingFileFocusPath(normalizedFilePath);
    get().setPendingFileNavigation(null);
    if (options?.expanded) {
      const zone = zoneOfMode(get().contextSurfaceZones, 'file');
      const panel = get().contextPanelByDirectory[normalizedDirectory];
      if (panel && !getZoneView(panel, zone).expanded) {
        get().toggleContextPanelExpanded(normalizedDirectory, zone);
      }
    }
  },

  openContextFileAtLine: (directory, filePath, line, column, options) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    const normalizedFilePath = normalizeContextTargetPath(filePath);
    const normalizedLine = Number.isFinite(line) ? Math.max(1, Math.trunc(line)) : 1;
    const normalizedColumn = Number.isFinite(column) ? Math.max(1, Math.trunc(column as number)) : 1;
    if (!normalizedDirectory || !normalizedFilePath) {
      return;
    }

    openFileTab(get(), normalizedDirectory, normalizedFilePath, options?.preview === true);
    get().setPendingFileFocusPath(null);
    get().setPendingFileNavigation({
      path: normalizedFilePath,
      line: normalizedLine,
      column: normalizedColumn,
    });
  },

  openContextOverview: (directory) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    if (!normalizedDirectory) {
      return;
    }

    get().openContextPanelTab(normalizedDirectory, { mode: 'context' });
  },

  openContextPreview: (directory, url) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    const normalizedUrl = (url || '').trim();
    if (!normalizedDirectory || !normalizedUrl || isVSCodeRuntime()) {
      return;
    }

    noteBrowserTabAddressRequested(get().contextPanelByDirectory, normalizedDirectory, normalizedUrl, normalizedUrl);
    get().openContextPanelTab(normalizedDirectory, {
      mode: 'browser',
      targetPath: normalizedUrl,
      dedupeKey: normalizedUrl,
      label: null,
    });
  },

  openAgentBrowserTab: (directory, url, ownerSessionId) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    if (!normalizedDirectory || isVSCodeRuntime()) return null;
    browserTabSequence += 1;
    const dedupeKey = `browser:agent:${Date.now()}-${browserTabSequence}`;
    if (url.trim()) noteBrowserTabAddressRequested(get().contextPanelByDirectory, normalizedDirectory, dedupeKey, url.trim());
    get().openContextPanelTab(normalizedDirectory, {
      mode: 'browser',
      targetPath: url.trim(),
      dedupeKey,
      label: null,
      ownerSessionId,
    }, { reveal: false });
    return buildContextPanelTabID('browser', dedupeKey);
  },

  openNewContextBrowserTab: (directory) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    if (!normalizedDirectory || isVSCodeRuntime()) return;
    browserTabSequence += 1;
    get().openContextPanelTab(normalizedDirectory, {
      mode: 'browser',
      targetPath: '',
      dedupeKey: `browser:new:${Date.now()}-${browserTabSequence}`,
      label: null,
    });
  },

  openContextBrowser: (directory, url = '', options) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    if (!normalizedDirectory || isVSCodeRuntime()) return;
    const targetUrl = typeof url === 'string' && url.trim().length > 0 ? url.trim() : '';
    if (targetUrl) noteBrowserTabAddressRequested(get().contextPanelByDirectory, normalizedDirectory, targetUrl, targetUrl);
    get().openContextPanelTab(normalizedDirectory, {
      mode: 'browser',
      targetPath: targetUrl,
      dedupeKey: targetUrl || 'browser',
      label: null,
    }, options);
  },

  setContextPanelTabTargetPath: (directory, tabID, targetPath) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    const normalizedTabID = (tabID || '').trim();
    if (!normalizedDirectory || !normalizedTabID) return;
    set((state) => {
      const current = state.contextPanelByDirectory[normalizedDirectory];
      if (!current) return state;
      return {
        contextPanelByDirectory: {
          ...state.contextPanelByDirectory,
          [normalizedDirectory]: setContextPanelTabTargetPath(current, normalizedTabID, targetPath),
        },
      };
    });
  },

  moveContextFilePaths: (directory, fromPath, toPath, filesRoot = directory) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    const normalizedFrom = normalizeContextTargetPath(fromPath);
    const normalizedTo = normalizeContextTargetPath(toPath);
    if (!normalizedDirectory || !normalizedFrom || !normalizedTo || normalizedFrom === normalizedTo) return;
    set((state) => {
      const current = state.contextPanelByDirectory[normalizedDirectory];
      if (!current) return state;
      const next = moveContextPanelFileTabs(current, normalizedFrom, normalizedTo);
      if (next === current) return state;
      return {
        contextPanelByDirectory: {
          ...state.contextPanelByDirectory,
          [normalizedDirectory]: next,
        },
      };
    });
    useFilesViewTabsStore.getState().movePaths(normalizeDirectoryPath(filesRoot.trim()), normalizedFrom, normalizedTo);
  },

  setActiveContextPanelTab: (directory, tabID) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    const normalizedTabID = (tabID || '').trim();
    if (!normalizedDirectory || !normalizedTabID) {
      return;
    }

    set((state) => {
      const prev = state.contextPanelByDirectory[normalizedDirectory];
      const current = touchContextPanelState(prev, state.contextSurfaceZones);
      const targetTab = current.tabs.find((tab) => tab.id === normalizedTabID);
      if (!targetTab) {
        return state;
      }

      const showsFile = targetTab.mode === 'file' && Boolean(targetTab.targetPath);
      const zone = zoneOfMode(state.contextSurfaceZones, targetTab.mode);
      const view = getZoneView(current, zone);

      // Зона — bookkeeping, который дерево опровергает в момент, когда
      // область закрывается, а её вкладка остаётся в ленте: `view` всё ещё
      // говорит «открыта и активна», пока ни один лист не рисует вкладку.
      // Без сдвига проходит только вкладка, которую область реально
      // показывает; непоставленная проваливается дальше и входит в область
      // по единому правилу размещения, которым идёт всякое открытие.
      const shownInALeaf = leavesOf(current.layout).some((leaf) => leaf.tabs.includes(normalizedTabID));
      if (view.activeTabId === normalizedTabID && view.isOpen && shownInALeaf) {
        return showsFile ? { contextEditorVisible: true } : state;
      }

      const activatedLayout = activateTabInTree(current.layout, normalizedTabID);
      const layout = shownInALeaf
        ? activatedLayout
        : openSurfaceInTree(current.layout, current.tabs, normalizedTabID, targetTab.mode).tree;

      const byDirectory = {
        ...state.contextPanelByDirectory,
        [normalizedDirectory]: withZoneView({
          ...current,
          layout,
          touchedAt: Date.now(),
          tabs: current.tabs.map((tab) => (tab.id === normalizedTabID
            ? { ...tab, touchedAt: Date.now() }
            : tab)),
        }, zone, { isOpen: true, activeTabId: normalizedTabID }),
      };

      return {
        contextPanelByDirectory: clampContextPanelRoots(byDirectory, 20),
        contextEditorVisible: showsFile || state.contextEditorVisible,
      };
    });
  },

  reorderContextPanelTabs: (directory, activeTabID, overTabID) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    const normalizedActiveTabID = (activeTabID || '').trim();
    const normalizedOverTabID = (overTabID || '').trim();
    if (!normalizedDirectory || !normalizedActiveTabID || !normalizedOverTabID) {
      return;
    }

    set((state) => {
      const prev = state.contextPanelByDirectory[normalizedDirectory];
      const current = touchContextPanelState(prev, state.contextSurfaceZones);
      if (!current.tabs.some((tab) => tab.id === normalizedActiveTabID) || !current.tabs.some((tab) => tab.id === normalizedOverTabID)) {
        return state;
      }

      const next = reorderContextPanelTabs(current, normalizedActiveTabID, normalizedOverTabID);
      if (next.tabs === current.tabs) {
        return state;
      }

      const byDirectory = {
        ...state.contextPanelByDirectory,
        [normalizedDirectory]: next,
      };

      return { contextPanelByDirectory: clampContextPanelRoots(byDirectory, 20) };
    });
  },

  pinContextPanelTab: (directory, tabID) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    if (!normalizedDirectory) return;
    set((state) => {
      const current = state.contextPanelByDirectory[normalizedDirectory];
      if (!current?.tabs.some((tab) => tab.id === tabID && tab.preview)) return state;
      return {
        contextPanelByDirectory: {
          ...state.contextPanelByDirectory,
          [normalizedDirectory]: {
            ...current,
            tabs: current.tabs.map((tab) => (tab.id === tabID ? { ...tab, preview: false } : tab)),
          },
        },
      };
    });
  },

  closeContextPanelTab: (directory, tabID) => {
    get().closeContextPanelTabs(directory, [tabID]);
  },

  closeContextFile: (directory, filePath) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    const normalizedFilePath = normalizeContextTargetPath(filePath);
    if (!normalizedDirectory || !normalizedFilePath) {
      return;
    }
    const tab = get().contextPanelByDirectory[normalizedDirectory]?.tabs
      .find((candidate) => candidate.mode === 'file' && candidate.targetPath === normalizedFilePath);
    if (tab) {
      get().closeContextPanelTabs(normalizedDirectory, [tab.id]);
      return;
    }
    useFilesViewTabsStore.getState().removeOpenPath(normalizedDirectory, normalizedFilePath);
  },

  closeContextPanelTabs: (directory, tabIds) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    const branchTabIds = new Set((get().contextPanelByDirectory[normalizedDirectory]?.tabs ?? [])
      .filter(isTrackerBranchTab)
      .map((tab) => tab.id));
    const normalizedTabIds = (tabIds ?? [])
      .map((id) => (id || '').trim())
      .filter((id) => id.length > 0 && !branchTabIds.has(id));
    if (!normalizedDirectory || normalizedTabIds.length === 0) {
      return;
    }

    const closedTabs = normalizedTabIds
      .map((id) => get().contextPanelByDirectory[normalizedDirectory]?.tabs.find((tab) => tab.id === id))
      .filter((tab): tab is ContextPanelTab => Boolean(tab));

    set((state) => {
      const placement = state.contextSurfaceZones;
      const prev = state.contextPanelByDirectory[normalizedDirectory];
      const current = touchContextPanelState(prev, placement);
      if (!current.tabs.some((tab) => normalizedTabIds.includes(tab.id))) {
        return state;
      }

      const next = closeContextPanelTabs(current, normalizedTabIds, placement);
      const fileView = getZoneView(next, zoneOfMode(placement, 'file'));
      const activeTab = next.tabs.find((tab) => tab.id === fileView.activeTabId);
      const returnedToTree = fileView.isOpen && activeTab?.mode === 'file' && !activeTab.targetPath;
      const byDirectory = {
        ...state.contextPanelByDirectory,
        [normalizedDirectory]: next,
      };

      return {
        contextPanelByDirectory: clampContextPanelRoots(byDirectory, 20),
        contextEditorTreeVisible: returnedToTree || state.contextEditorTreeVisible,
      };
    });

    for (const tab of closedTabs) {
      if (tab.mode === 'file' && tab.targetPath) {
        useFilesViewTabsStore.getState().removeOpenPath(normalizedDirectory, tab.targetPath);
      }
    }
  },

  closeContextSurfaceTabs: (directory, mode) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    if (!normalizedDirectory) {
      return;
    }
    const panel = get().contextPanelByDirectory[normalizedDirectory];
    const ids = (panel?.tabs ?? []).filter((tab) => tab.mode === mode).map((tab) => tab.id);
    if (ids.length > 0) {
      get().closeContextPanelTabs(normalizedDirectory, ids);
    }
  },
});
