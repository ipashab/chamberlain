import { z } from 'zod';
import { rebaseMovedPath } from '@/lib/filePathMoves';
import {
  getZoneView,
  resolveZoneActiveTab,
  resolveZoneActiveTabId,
  keepZoneViewsOnTabs,
  zoneViewsSchema,
  settleZones,
  withZoneView,
  zoneOfMode,
  CLOSED_ZONE_VIEW,
  CONTEXT_ZONES,
  zonePlacementSchema,
} from '@/lib/workspace/zones';
import type { ContextZone, ContextZonePlacement, ContextZoneView } from '@/lib/workspace/zones';
import {
  CHAT_NODE,
  openSurfaceInTree,
  renameTabsInTree,
  sanitizeTree,
  storedTreeSchema,
  treeFromZonedPanel,
  findLeaf,
  moveTabToLeaf,
  type WorkspaceTree,
} from '@/lib/workspace/layoutTree';
import {
  BOARD_DETAIL_LEAF_ID,
  BOARD_DETAIL_MODES,
  DEBUG_EDITOR_LEAF_ID,
  DEBUG_EDITOR_MODES,
  DEFAULT_WORKSPACE_MODE,
  isWorkspaceMode,
  type WorkspaceMode,
  type WorkspaceModeLayouts,
} from '@/lib/workspace/modePresets';
import type { ContextPanelMode } from '@/lib/surfaces/modes';
import type {
  ContextPanelTab,
  ContextPanelTabDescriptor,
  ContextPanelDirectoryState,
  ContextZoneReturnEntry,
  ContextZoneReturnStacks,
  LegacyZoneSizes,
} from './types';
import {
  CONTEXT_PANEL_MAX_TABS,
  normalizeDirectoryPath,
  clampContextZoneSize,
  buildContextPanelTabID,
  createContextPanelTab,
  clampContextPanelTabs,
  sanitizeContextPanelTabs,
  resolveActiveContextPanelTabID,
} from './contextTabs';

const persistedPixelsSchema = z.number().finite().optional().catch(undefined);

const persistedZoneSizesSchema = z.object({
  sizeByZone: z.object({
    left: persistedPixelsSchema,
    right: persistedPixelsSchema,
    bottom: persistedPixelsSchema,
  }).optional().catch(undefined),
  widthByMode: z.record(z.string(), persistedPixelsSchema).catch({}),
  heightByMode: z.record(z.string(), persistedPixelsSchema).catch({}),
});

export const touchContextPanelState = (
  prev: ContextPanelDirectoryState | undefined,
  placement: ContextZonePlacement,
): ContextPanelDirectoryState => {
  if (prev) {
    const tabs = sanitizeContextPanelTabs(prev.tabs);
    const presentTabIds = new Set(tabs.map((tab) => tab.id));
    return settleZones({
      ...prev,
      tabs,
      workspaceMode: isWorkspaceMode(prev.workspaceMode) ? prev.workspaceMode : DEFAULT_WORKSPACE_MODE,
      modeLayouts: sanitizeModeLayouts(prev.modeLayouts, presentTabIds),
      layout: sanitizeTree(layoutOrChat(prev.layout), presentTabIds),
      zones: keepZoneViewsOnTabs(zoneViewsSchema.parse(prev.zones), presentTabIds),
      touchedAt: Date.now(),
    }, placement);
  }

  return {
    isOpen: false,
    expanded: false,
    tabs: [],
    activeTabId: null,
    zones: { left: CLOSED_ZONE_VIEW, bottom: CLOSED_ZONE_VIEW },
    layout: CHAT_NODE,
    modeLayouts: {},
    workspaceMode: DEFAULT_WORKSPACE_MODE,
    touchedAt: Date.now(),
  };
};

// Состояние каталога, записанное до появления дерева раскладки, дерева не несёт:
// оно читается как один чат и достраивается обычным открытием.
const layoutOrChat = (layout: WorkspaceTree | undefined): WorkspaceTree => layout ?? CHAT_NODE;

const sanitizeModeLayouts = (
  modeLayouts: WorkspaceModeLayouts | null | undefined,
  presentTabIds: ReadonlySet<string>,
): WorkspaceModeLayouts => {
  if (!modeLayouts) {
    return {};
  }
  const next: WorkspaceModeLayouts = {};
  for (const [mode, tree] of Object.entries(modeLayouts)) {
    if (tree === undefined || !isWorkspaceMode(mode)) continue;
    // Искажённые сохранённые деревья снимают слот: режим отстроит свой пресет
    // заново при следующем входе, а живые вкладки остаются в ленте.
    try {
      next[mode] = sanitizeTree(storedTreeSchema.parse(tree), presentTabIds);
    } catch {
      // Отсутствующий слот лучше сломанного дерева; пресет вернётся при следующем входе.
    }
  }
  return next;
};

export const upsertContextPanelTab = (
  current: ContextPanelDirectoryState,
  descriptor: ContextPanelTabDescriptor,
  placement: ContextZonePlacement,
  options?: { reveal?: boolean },
): ContextPanelDirectoryState => {
  const reveal = options?.reveal !== false;
  const nextTab = createContextPanelTab(descriptor);
  const baseTabs = nextTab.mode === 'file' && nextTab.targetPath
    ? current.tabs.filter((tab) => !(tab.mode === 'file' && !tab.targetPath))
    : current.tabs;
  const existingIndex = baseTabs.findIndex((tab) => tab.id === nextTab.id);
  const replacedPreviewIndex = existingIndex === -1 && nextTab.preview
    ? baseTabs.findIndex((tab) => tab.preview)
    : -1;
  const tabs = replacedPreviewIndex !== -1
    ? baseTabs.map((tab, index) => (index === replacedPreviewIndex ? nextTab : tab))
    : existingIndex === -1
    ? [...baseTabs, nextTab]
    : baseTabs.map((tab, index) => (index === existingIndex
      ? {
          ...tab,
          mode: nextTab.mode,
          targetPath: nextTab.targetPath || tab.targetPath,
          targetDirectory: nextTab.targetDirectory,
          dedupeKey: nextTab.dedupeKey,
          label: nextTab.label,
          sessionTitleFallback: nextTab.sessionTitleFallback || tab.sessionTitleFallback,
          stagedDiff: nextTab.stagedDiff,
          diffScope: nextTab.diffScope,
          readOnly: nextTab.readOnly,
          preview: tab.preview && nextTab.preview,
          touchedAt: Date.now(),
        }
      : tab));

  const zone = zoneOfMode(placement, nextTab.mode);
  const view = getZoneView(current, zone);
  const activeTabId = reveal
    ? nextTab.id
    : resolveZoneActiveTabId(current.tabs, placement, zone, view.activeTabId) ?? nextTab.id;
  const clampedTabs = clampContextPanelTabs(tabs, CONTEXT_PANEL_MAX_TABS, activeTabId);

  // Дерево зеркалит ленту: вкладки, которые открытие заменило или которые
  // отставил клэмп, покидают свои листья, а открытая и показанная вкладка
  // встаёт по единому правилу, которое кодирует openSurfaceInTree — туда,
  // где её поверхность уже показана, иначе первый заполненный лист, иначе
  // первый пустой, иначе новое разбиение. Фоновое открытие ничего не ставит:
  // вкладка живёт в ленте, её панель жива в лимбе раскладки, пока открытие
  // её не покажет.
  const sanitizedLayout = sanitizeTree(layoutOrChat(current.layout), new Set(clampedTabs.map((tab) => tab.id)));
  let layout = reveal
    ? openSurfaceInTree(sanitizedLayout, clampedTabs, nextTab.id, nextTab.mode).tree
    : sanitizedLayout;

  // Режим доски держит именованный лист подробностей рядом с доской — для
  // карточек, диффов и прохождений Трекера: они открываются в него, а не
  // наслаиваются на собственную область доски и не дробят чат. Пользователь,
  // закрывший лист подробностей, возвращается к общему правилу размещения выше.
  const boardDetailLeaf = current.workspaceMode === 'board' && BOARD_DETAIL_MODES.has(nextTab.mode)
    ? findLeaf(layout, BOARD_DETAIL_LEAF_ID)
    : null;
  if (boardDetailLeaf && !boardDetailLeaf.tabs.includes(nextTab.id)) {
    layout = moveTabToLeaf(layout, nextTab.id, BOARD_DETAIL_LEAF_ID);
  }

  // Режим отладки держит свой лист редактора как область файлов: файл или
  // дифф, открытые при включённом режиме, встают туда, поэтому общее правило
  // не может уронить их в лист отладчика и опустошить редактор над ним —
  // раскладка остаётся «файлы сверху, отладчик снизу» между открытиями.
  // Пользователь, закрывший лист редактора, возвращается к общему правилу выше.
  const debugEditorLeaf = current.workspaceMode === 'debug' && DEBUG_EDITOR_MODES.has(nextTab.mode)
    ? findLeaf(layout, DEBUG_EDITOR_LEAF_ID)
    : null;
  if (debugEditorLeaf && !debugEditorLeaf.tabs.includes(nextTab.id)) {
    layout = moveTabToLeaf(layout, nextTab.id, DEBUG_EDITOR_LEAF_ID);
  }

  return settleZones(withZoneView({
    ...current,
    tabs: clampedTabs,
    layout,
    touchedAt: Date.now(),
  }, zone, {
    isOpen: reveal ? true : view.isOpen,
    activeTabId,
  }), placement);
};

export const closeContextPanelTabs = (
  current: ContextPanelDirectoryState,
  tabIds: readonly string[],
  placement: ContextZonePlacement,
): ContextPanelDirectoryState => {
  const closed = new Set(tabIds);
  const closedTabs = current.tabs.filter((tab) => closed.has(tab.id));
  let nextTabs = current.tabs.filter((tab) => !closed.has(tab.id));
  if (nextTabs.length === current.tabs.length) {
    return current;
  }

  const views: Partial<Record<ContextZone, Partial<ContextZoneView>>> = {};
  let placeholderTabId: string | null = null;
  for (const zone of CONTEXT_ZONES) {
    const view = getZoneView(current, zone);
    const activeClosed = view.activeTabId ? closed.has(view.activeTabId) : false;
    if (!activeClosed) continue;

    const activeMode = closedTabs.find((tab) => tab.id === view.activeTabId)?.mode ?? null;
    const sameModeTabs = activeMode ? nextTabs.filter((tab) => tab.mode === activeMode) : [];
    const nextSameModeTab = sameModeTabs.length > 0
      ? sameModeTabs.reduce((best, tab) => (tab.touchedAt >= best.touchedAt ? tab : best))
      : null;

    if (activeMode === 'file' && !nextSameModeTab && closedTabs.some((tab) => tab.mode === 'file' && tab.targetPath)) {
      const placeholder = createContextPanelTab({ mode: 'file' });
      placeholderTabId = placeholder.id;
      nextTabs = [...nextTabs, placeholder];
      views[zone] = { activeTabId: placeholder.id };
      continue;
    }

    views[zone] = nextSameModeTab
      ? { activeTabId: nextSameModeTab.id }
      : { activeTabId: null, isOpen: false, expanded: false };
  }

  let layout = sanitizeTree(layoutOrChat(current.layout), new Set(nextTabs.map((tab) => tab.id)));
  if (placeholderTabId) {
    layout = openSurfaceInTree(layout, nextTabs, placeholderTabId, 'file').tree;
  }

  let next: ContextPanelDirectoryState = { ...current, tabs: nextTabs, layout, touchedAt: Date.now() };
  for (const zone of CONTEXT_ZONES) {
    const patch = views[zone];
    if (patch) next = withZoneView(next, zone, patch);
  }
  return settleZones(next, placement);
};

export const reorderContextPanelTabs = (
  current: ContextPanelDirectoryState,
  activeTabID: string,
  overTabID: string,
): ContextPanelDirectoryState => {
  if (activeTabID === overTabID) {
    return current;
  }

  const fromIndex = current.tabs.findIndex((tab) => tab.id === activeTabID);
  const toIndex = current.tabs.findIndex((tab) => tab.id === overTabID);
  if (fromIndex === -1 || toIndex === -1) {
    return current;
  }

  const tabs = [...current.tabs];
  const [moved] = tabs.splice(fromIndex, 1);
  if (!moved) {
    return current;
  }

  tabs.splice(toIndex, 0, moved);

  return {
    ...current,
    tabs,
    touchedAt: Date.now(),
  };
};

export const setContextPanelTabTargetPath = (
  current: ContextPanelDirectoryState,
  tabID: string,
  targetPath: string,
): ContextPanelDirectoryState => ({
  ...current,
  tabs: current.tabs.map((tab) =>
    tab.id === tabID ? { ...tab, targetPath } : tab,
  ),
});

export const moveContextPanelFileTabs = (
  current: ContextPanelDirectoryState,
  fromPath: string,
  toPath: string,
): ContextPanelDirectoryState => {
  const renamed = new Map<string, string>();
  const movedIds = new Set<string>();
  const tabs = current.tabs.map((tab) => {
    if (tab.mode !== 'file' || !tab.targetPath) return tab;
    const targetPath = rebaseMovedPath(tab.targetPath, fromPath, toPath);
    if (targetPath === null) return tab;
    const keyFollowsPath = tab.dedupeKey === tab.targetPath;
    const dedupeKey = keyFollowsPath ? targetPath : tab.dedupeKey;
    const id = keyFollowsPath ? buildContextPanelTabID(tab.mode, dedupeKey) : tab.id;
    renamed.set(tab.id, id);
    movedIds.add(id);
    return { ...tab, targetPath, dedupeKey, id };
  });
  if (movedIds.size === 0) return current;

  let next: ContextPanelDirectoryState = {
    ...current,
    tabs: tabs.filter((tab, index) => tab !== current.tabs[index] || !movedIds.has(tab.id)),
    layout: renameTabsInTree(layoutOrChat(current.layout), renamed),
    touchedAt: Date.now(),
  };
  for (const zone of CONTEXT_ZONES) {
    const activeTabId = getZoneView(current, zone).activeTabId;
    const renamedId = activeTabId ? renamed.get(activeTabId) : undefined;
    if (renamedId) next = withZoneView(next, zone, { activeTabId: renamedId });
  }
  return next;
};

export const withoutForeignComparisons = (
  byDirectory: Record<string, ContextPanelDirectoryState>,
): Record<string, ContextPanelDirectoryState> => {
  const isForeign = (tab: ContextPanelTab) => (tab.mode === 'diff' || tab.mode === 'walkthrough') && tab.targetDirectory !== null;
  if (!Object.values(byDirectory).some((panel) => panel.tabs.some(isForeign))) return byDirectory;
  return Object.fromEntries(Object.entries(byDirectory).map(([directory, panel]) => [directory, panel.tabs.some(isForeign)
    ? { ...panel, tabs: panel.tabs.map((tab) => (isForeign(tab) ? { ...tab, targetDirectory: null } : tab)) }
    : panel]));
};

export const sanitizeContextPanelByDirectory = (
  value: unknown,
  placement?: unknown,
  legacySizes?: LegacyZoneSizes[],
): Record<string, ContextPanelDirectoryState> => {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const parsedPlacement = zonePlacementSchema.parse(placement ?? {});
  const source = value as Record<string, unknown>;
  const next: Record<string, ContextPanelDirectoryState> = {};

  for (const [rawDirectory, rawState] of Object.entries(source)) {
    const directory = normalizeDirectoryPath(rawDirectory);
    if (!directory || !rawState || typeof rawState !== 'object') {
      continue;
    }

    const candidate = rawState as {
      isOpen?: unknown;
      expanded?: unknown;
      zones?: unknown;
      tabs?: unknown;
      activeTabId?: unknown;
      touchedAt?: unknown;
      mode?: unknown;
      targetPath?: unknown;
      targetDirectory?: string | null;
      dedupeKey?: unknown;
      label?: unknown;
      layout?: unknown;
      workspaceMode?: WorkspaceMode | null;
      modeLayouts?: Partial<Record<WorkspaceMode, WorkspaceTree>> | null;
    };

    let tabs = sanitizeContextPanelTabs(candidate.tabs);
    let activeTabId = typeof candidate.activeTabId === 'string' ? candidate.activeTabId : null;

    if (tabs.length === 0 && (candidate.mode === 'diff' || candidate.mode === 'file' || candidate.mode === 'context' || candidate.mode === 'chat' || candidate.mode === 'terminal')) {
      tabs = [createContextPanelTab({
        mode: candidate.mode,
        targetPath: typeof candidate.targetPath === 'string' ? candidate.targetPath : null,
        targetDirectory: candidate.targetDirectory,
        dedupeKey: typeof candidate.dedupeKey === 'string' ? candidate.dedupeKey : null,
        label: typeof candidate.label === 'string' ? candidate.label : null,
      })];
      activeTabId = tabs[0]?.id ?? null;
    }

    const resolvedActiveTabId = resolveActiveContextPanelTabID(tabs, activeTabId);
    const clampedTabs = clampContextPanelTabs(tabs, CONTEXT_PANEL_MAX_TABS, resolvedActiveTabId);

    const resolvedTabId = resolveActiveContextPanelTabID(clampedTabs, resolvedActiveTabId);
    const zones = keepZoneViewsOnTabs(zoneViewsSchema.parse(candidate.zones), new Set(clampedTabs.map((tab) => tab.id)));
    // Дерево раскладки читается из размещения поверхностей, когда сохранённое
    // состояние его опережает: открытые зоны становятся листьями там, где они
    // стояли, вкладки закрытых зон остаются в ленте и входят в лист в день
    // своего открытия. Сохранённое дерево вместо этого чинится по уцелевшей
    // ленте — вкладки, не пережившие очистки, покидают свои листья.
    const presentTabIds = new Set(clampedTabs.map((tab) => tab.id));
    const layout = candidate.layout !== undefined
      ? sanitizeTree(storedTreeSchema.parse(candidate.layout), presentTabIds)
      : treeFromZonedPanel({
          isOpen: candidate.isOpen === true,
          activeTabId: resolvedTabId,
          tabs: clampedTabs,
          zones,
        }, parsedPlacement);
    const touchedAt = typeof candidate.touchedAt === 'number' && Number.isFinite(candidate.touchedAt)
      ? candidate.touchedAt
      : Date.now();
    if (legacySizes) {
      const savedSizes = persistedZoneSizesSchema.parse(rawState);
      const sizes: Partial<Record<ContextZone, number>> = {};
      for (const zone of CONTEXT_ZONES) {
        let pixels = savedSizes.sizeByZone?.[zone];
        if (!savedSizes.sizeByZone) {
          const zoneTabId = zone === 'right' ? resolvedTabId : zones[zone].activeTabId;
          const mode = clampedTabs.find((tab) => tab.id === zoneTabId)?.mode;
          pixels = mode ? (zone === 'bottom' ? savedSizes.heightByMode : savedSizes.widthByMode)[mode] : undefined;
        }
        if (pixels !== undefined) sizes[zone] = clampContextZoneSize(zone, pixels);
      }
      legacySizes.push({ sizes, touchedAt });
    }

    next[directory] = {
      isOpen: candidate.isOpen === true,
      expanded: candidate.expanded === true,
      tabs: clampedTabs,
      activeTabId: resolvedTabId,
      zones,
      layout,
      workspaceMode: candidate.workspaceMode ?? DEFAULT_WORKSPACE_MODE,
      // Сломанные сохранённые дерева снимаются внутри; эти режимы отстроят
      // свои пресеты при следующем входе.
      modeLayouts: sanitizeModeLayouts(candidate.modeLayouts, presentTabIds),
      touchedAt,
    };
  }

  return next;
};

export const clampContextPanelRoots = (
  byDirectory: Record<string, ContextPanelDirectoryState>,
  maxRoots: number
): Record<string, ContextPanelDirectoryState> => {
  const entries = Object.entries(byDirectory);
  if (entries.length <= maxRoots) {
    return byDirectory;
  }

  entries.sort((a, b) => (b[1]?.touchedAt ?? 0) - (a[1]?.touchedAt ?? 0));
  const next: Record<string, ContextPanelDirectoryState> = {};
  for (const [directory, state] of entries.slice(0, maxRoots)) {
    next[directory] = state;
  }
  return next;
};

const MAX_CONTEXT_ZONE_RETURN_STACK = 10;

export const setContextZoneReturnStack = (
  stacks: ContextZoneReturnStacks,
  directory: string,
  zone: ContextZone,
  entries: readonly ContextZoneReturnEntry[],
): ContextZoneReturnStacks => {
  const currentDir = stacks[directory];
  if (entries.length === 0) {
    if (!currentDir || !(zone in currentDir)) {
      return stacks;
    }
    const nextDir = { ...currentDir };
    delete nextDir[zone];
    if (Object.keys(nextDir).length === 0) {
      const nextStacks = { ...stacks };
      delete nextStacks[directory];
      return nextStacks;
    }
    return { ...stacks, [directory]: nextDir };
  }

  return {
    ...stacks,
    [directory]: {
      ...currentDir,
      [zone]: entries.slice(-MAX_CONTEXT_ZONE_RETURN_STACK),
    },
  };
};

export const clearContextZoneReturnStack = (
  stacks: ContextZoneReturnStacks,
  directory: string,
  zone: ContextZone,
): ContextZoneReturnStacks => setContextZoneReturnStack(stacks, directory, zone, []);

export const pruneContextZoneReturnStacks = (
  stacks: ContextZoneReturnStacks,
  keptByDirectory: Record<string, ContextPanelDirectoryState>,
): ContextZoneReturnStacks => {
  const dirs = Object.keys(stacks);
  if (dirs.every((dir) => dir in keptByDirectory)) {
    return stacks;
  }
  const next: ContextZoneReturnStacks = {};
  for (const dir of dirs) {
    if (dir in keptByDirectory) {
      next[dir] = stacks[dir];
    }
  }
  return next;
};

export const pushContextZoneReturnEntry = (
  stacks: ContextZoneReturnStacks,
  directory: string,
  zone: ContextZone,
  previousTab: Pick<ContextPanelTab, 'id' | 'mode'> | null,
  nextMode: ContextPanelMode,
): ContextZoneReturnStacks => {
  if (!previousTab || previousTab.mode === nextMode) {
    return stacks;
  }

  const existing = stacks[directory]?.[zone] ?? [];
  const filtered = existing.filter((entry) => entry.mode !== nextMode && entry.mode !== previousTab.mode);
  return setContextZoneReturnStack(stacks, directory, zone, [
    ...filtered,
    { tabId: previousTab.id, mode: previousTab.mode },
  ]);
};

export const resolveContextZoneReturnTarget = (
  panel: ContextPanelDirectoryState | undefined,
  placement: ContextZonePlacement,
  zone: ContextZone,
  stack: readonly ContextZoneReturnEntry[] | undefined,
  eligibleTabIds?: ReadonlySet<string>,
): { tab: ContextPanelTab; remainingStack: ContextZoneReturnEntry[] } | null => {
  if (!panel || !stack || stack.length === 0) {
    return null;
  }

  const isEligible = (tab: ContextPanelTab): boolean => (
    zoneOfMode(placement, tab.mode) === zone
    && (!eligibleTabIds || eligibleTabIds.has(tab.id))
  );

  const view = getZoneView(panel, zone);
  const activeTab = view.isOpen ? resolveZoneActiveTab(panel, placement, zone) : null;

  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const entry = stack[index];
    if (!entry) continue;
    if (activeTab && entry.mode === activeTab.mode) continue;
    if (zoneOfMode(placement, entry.mode) !== zone) continue;

    const exact = panel.tabs.find((tab) => tab.id === entry.tabId && isEligible(tab));
    if (exact) {
      return { tab: exact, remainingStack: stack.slice(0, index) };
    }

    const modeTabs = panel.tabs.filter((tab) => tab.mode === entry.mode && isEligible(tab));
    if (modeTabs.length > 0) {
      const mostRecent = modeTabs.reduce((best, tab) => (tab.touchedAt >= best.touchedAt ? tab : best));
      return { tab: mostRecent, remainingStack: stack.slice(0, index) };
    }
  }

  return null;
};
