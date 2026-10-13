import React from 'react';
import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { CHAT_NODE, edgeRegionShowsTabs } from '@/lib/workspace/layoutTree';

/**
 * Fixed panel width. The panel is not user-resizable: it is an object inside
 * the chat rather than a docked pane, so it has no resizer and no persisted
 * width.
 */
export const WORK_STATUS_PANEL_WIDTH = 300;

/**
 * Minimum width the message column must keep for itself. Below this the panel
 * yields — a squeezed transcript costs more than the status it displaces.
 */
const WORK_STATUS_MIN_CHAT_WIDTH = 560;

/** The card's own horizontal margins (`ms-2` + `me-4`). */
const WORK_STATUS_PANEL_GUTTER = 8 + 16;

/** The card's column in the right slot: the card and its margins. */
export const WORK_STATUS_COLUMN_WIDTH = WORK_STATUS_PANEL_WIDTH + WORK_STATUS_PANEL_GUTTER;

/** Row width below which the panel gives its space back to the transcript. */
export const WORK_STATUS_REQUIRED_ROW_WIDTH = WORK_STATUS_COLUMN_WIDTH + WORK_STATUS_MIN_CHAT_WIDTH;

type Options = {
  isMobile: boolean;
  isVSCode: boolean;
};

type Result = {
  /** Layout can host the panel inline, regardless of the user's switch. */
  fits: boolean;
  /**
   * The chat area is wide enough for the panel's column, whether or not the
   * context panel is open. The right slot keeps the column for the card on
   * this, so closing the context panel goes straight back to it.
   */
  roomy: boolean;
  /**
   * Attach to the flex row that contains the chat column and the panel.
   *
   * A callback ref, not an object ref: an object ref gives no signal when the
   * node attaches, so a measuring effect that reads `.current` would silently
   * observe nothing whenever the row mounts after the effect first ran, and
   * would only recover on the next unrelated dependency change.
   */
  rowRef: (node: HTMLDivElement | null) => void;
  visible: boolean;
};

/**
 * Decides whether the work-status panel may occupy space inside the chat.
 *
 * The width test measures the ROW (chat column + panel), never the chat column
 * alone. The chat column's width is an output of this decision: hiding the
 * panel widens it, which would re-satisfy a chat-width test and re-show the
 * panel, oscillating forever. The row width is independent of the panel, so it
 * is the only stable input.
 */
export const useWorkStatusVisibility = ({ isMobile, isVSCode }: Options): Result => {
  const [rowNode, setRowNode] = React.useState<HTMLDivElement | null>(null);
  // Only the threshold decision is state: the chat area's width changes on
  // every frame of a sidebar animation, and storing the width itself
  // re-rendered the whole chat on each of those frames.
  const [wideEnough, setWideEnough] = React.useState<boolean | null>(null);
  const rowRef = React.useCallback((node: HTMLDivElement | null) => { setRowNode(node); }, []);

  // Keyed exactly like the rail and the panel itself: whichever directory the
  // app is effectively on, not the directory this panel reports about. A chat
  // with no project reports on nothing, and looking the context panel up under
  // that empty key answered "closed" while it was plainly open on screen.
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
      (state) => edgeRegionShowsTabs(
        (directoryKey ? state.contextPanelByDirectory[directoryKey] : undefined)?.layout ?? CHAT_NODE,
        'end',
      ),
      [directoryKey],
    ),
  );

  // The user's own switch, persisted to server settings, gates everything
  // before layout is even measured.
  const panelEnabled = useUIStore((state) => state.workStatusPanelEnabled);

  // Split from the switch: a narrow chat is a layout fact, and the header needs
  // it to offer the panel as an overlay instead of pretending it is off.
  const layoutAllows = !isMobile && !isVSCode && !contextPanelOpen;

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
  // Runtimes without a workspace row (VS Code, mini chat) fall back to the
  // chat area and then to the handed row; none of them shows the card.
  React.useEffect(() => {
    if (!rowNode || typeof ResizeObserver === 'undefined') return undefined;

    const measured = rowNode.closest<HTMLElement>('[data-workspace-row]') ?? rowNode.closest<HTMLElement>('[data-chat-area]') ?? rowNode;
    setWideEnough(measured.getBoundingClientRect().width >= WORK_STATUS_REQUIRED_ROW_WIDTH);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setWideEnough(entry.contentRect.width >= WORK_STATUS_REQUIRED_ROW_WIDTH);
    });
    observer.observe(measured);
    return () => observer.disconnect();
  }, [rowNode]);

  const roomy = !isMobile && !isVSCode && wideEnough === true;
  const fits = layoutAllows && roomy;
  const visible = panelEnabled && fits;

  return { rowRef, visible, fits, roomy };
};
