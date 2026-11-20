import React from 'react';
import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { sidebarPendingWidth } from '@/components/layout/sidebarPendingWidth';
import { edgeRegionShowsTabs } from '@/lib/workspace/layoutTree';
import {
  CONTEXT_ZONE_DEFAULT_WIDTH,
  isZoneShown,
  resolveZoneActiveTab,
  showsFileTreeOnly,
  sideZoneWidth,
} from '@/lib/workspace/zones';

export const WORK_STATUS_PANEL_WIDTH = 300;

const WORK_STATUS_MIN_CHAT_WIDTH = 560;

const WORK_STATUS_PANEL_GUTTER = 8 + 16;

export const WORK_STATUS_COLUMN_WIDTH = WORK_STATUS_PANEL_WIDTH + WORK_STATUS_PANEL_GUTTER;

export const WORK_STATUS_REQUIRED_ROW_WIDTH = WORK_STATUS_COLUMN_WIDTH + WORK_STATUS_MIN_CHAT_WIDTH;

type Options = {
  isMobile: boolean;
  isVSCode: boolean;
};

type Result = {
  fits: boolean;
  roomy: boolean;
  roomyBesidePanel: boolean;
  rowRef: (node: HTMLDivElement | null) => void;
  visible: boolean;
};

export const useWorkStatusVisibility = ({ isMobile, isVSCode }: Options): Result => {
  const [rowNode, setRowNode] = React.useState<HTMLDivElement | null>(null);
  const [wideEnough, setWideEnough] = React.useState<boolean | null>(null);
  const [wideEnoughBesidePanel, setWideEnoughBesidePanel] = React.useState(false);
  const rowRef = React.useCallback((node: HTMLDivElement | null) => { setRowNode(node); }, []);

  const effectiveDirectory = useEffectiveDirectory();
  const directoryKey = React.useMemo(
    () => (effectiveDirectory ? normalizeContextPanelDirectoryKey(effectiveDirectory) : ''),
    [effectiveDirectory],
  );

  // Mirrors the workspace row's own derivation: the card's column stands at
  // the row's end edge, so only a region showing tabs there displaces it —
  // regardless of how deep the splits go. (RTL is settled by the layout's
  // own logical-direction mapping, not here.)
  const contextPanelOpen = useUIStore(
    React.useCallback(
      (state) => {
        const panel = directoryKey ? state.contextPanelByDirectory[directoryKey] : undefined;
        // The fork's entries carry the layout tree; an entry without one (the
        // upstream zone model's shape) answers by its own open flag — but an
        // open panel with no tab renders nothing and displaces nothing.
        return panel?.layout
          ? edgeRegionShowsTabs(panel.layout, 'end')
          : Boolean(panel?.isOpen && (panel.tabs?.length ?? 0) > 0);
      },
      [directoryKey],
    ),
  );

  const contextPanelWidth = useUIStore(
    React.useCallback(
      (state) => {
        const panel = directoryKey ? state.contextPanelByDirectory[directoryKey] : undefined;
        const tab = panel ? resolveZoneActiveTab(panel, state.contextSurfaceZones, 'right') : null;
        return panel && tab ? sideZoneWidth(panel, tab, 'right', state) : CONTEXT_ZONE_DEFAULT_WIDTH;
      },
      [directoryKey],
    ),
  );
  const contextPanelExpanded = useUIStore(
    React.useCallback(
      (state) => {
        const panel = directoryKey ? state.contextPanelByDirectory[directoryKey] : undefined;
        if (!panel?.expanded) return false;
        const tab = isZoneShown(panel, state.contextSurfaceZones, 'right')
          ? resolveZoneActiveTab(panel, state.contextSurfaceZones, 'right')
          : null;
        return tab !== null && !showsFileTreeOnly(panel, tab, state);
      },
      [directoryKey],
    ),
  );

  const panelEnabled = useUIStore((state) => state.workStatusPanelEnabled);

  // Measures the workspace ROW — the outermost flex row that holds the
  // layout tree (chat and every region) and the card's own column.
  //
  // The row's width comes from its parent: nothing inside it can move it.
  // The chat itself cannot be the input — every region's share moves it, and
  // so does this card's own column, which opens at the row's end edge
  // whenever no region shows tabs there. Measuring anything the card can
  // resize makes the two states each re-decide the other's input forever:
  // the column opens, the narrower chat crosses the threshold, the column
  // closes, the chat crosses back, and the whole row thrashes on every
  // ResizeObserver tick. The row is the one container whose width is the
  // same whether the card is showing.
  //
  // It is also the stable input the oscillation argument needs: this panel's
  // own visibility cannot change the width being measured. Nor can the context
  // panel's: its width is the user's setting, read from the store. The row is
  // measured as it will be once the session sidebar reaches the width it was
  // set to (sidebarPendingWidth), so a sidebar fold or unfold moves the row
  // once, not a frame late.
  const areaWidthRef = React.useRef<number | null>(null);
  const contextPanelWidthRef = React.useRef(contextPanelWidth);
  contextPanelWidthRef.current = contextPanelWidth;
  const applyAreaWidth = React.useCallback((measured: number) => {
    areaWidthRef.current = measured;
    const width = measured + sidebarPendingWidth();
    setWideEnough(width >= WORK_STATUS_REQUIRED_ROW_WIDTH);
    setWideEnoughBesidePanel(width >= WORK_STATUS_REQUIRED_ROW_WIDTH + contextPanelWidthRef.current);
  }, []);

  // Runtimes without a workspace row (VS Code, mini chat) fall back to the
  // chat area and then to the handed row; none of them shows the card.
  React.useEffect(() => {
    if (!rowNode || typeof ResizeObserver === 'undefined') return undefined;

    const measured = rowNode.closest<HTMLElement>('[data-workspace-row]') ?? rowNode.closest<HTMLElement>('[data-chat-area]') ?? rowNode;
    applyAreaWidth(measured.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      applyAreaWidth(entry.contentRect.width);
    });
    observer.observe(measured);
    return () => observer.disconnect();
  }, [applyAreaWidth, rowNode]);

  const sidebarOpen = useUIStore((state) => panelEnabled && state.isSidebarOpen);
  React.useLayoutEffect(() => {
    if (areaWidthRef.current !== null) applyAreaWidth(areaWidthRef.current);
  }, [applyAreaWidth, contextPanelWidth, sidebarOpen]);

  const roomy = !isMobile && wideEnough === true;
  const roomyBesidePanel = roomy && wideEnoughBesidePanel && !contextPanelExpanded;
  const fits = contextPanelOpen && !isVSCode ? roomyBesidePanel : roomy;
  const visible = panelEnabled && fits;

  return { rowRef, visible, fits, roomy, roomyBesidePanel };
};
