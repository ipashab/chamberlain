import React from 'react';
import { createPortal } from 'react-dom';
import { usePaneHostsStore } from './regionHosts';

type HostParent = HTMLElement & { moveBefore?: (node: Node, child: Node | null) => void };

/**
 * Renders a keep-alive surface into the body of the region (layout leaf)
 * that holds its tab. The content lives in one detached element for the
 * pane's whole life; changing `hostKey` moves that element, so React keeps
 * the component and the DOM keeps its state: the editor its text and undo,
 * the terminal its session. `moveBefore` keeps focus, scroll and iframes
 * through the move where the engine has it. An Electron webview reloads on
 * any move; it moves only when its tab moves.
 *
 * A tab with no region (its leaf was closed) keeps its element detached and
 * alive — the pane stays mounted, just nowhere to be seen.
 *
 * The element is `display: contents`, so the pane's own wrapper is laid out
 * by the region body as if it were a direct child.
 */
export const MovablePane: React.FC<{ hostKey: string | null; children: React.ReactNode }> = ({ hostKey, children }) => {
  const [node] = React.useState(() => {
    const element = document.createElement('div');
    element.style.display = 'contents';
    return element;
  });
  const host = usePaneHostsStore((state) => (hostKey ? state.byKey[hostKey]?.body ?? null : null));

  React.useLayoutEffect(() => {
    // The frame registers its body from a ref, earlier in the same commit, so
    // a pane lands in its final region on first attach.
    const parent: HostParent | null = host ?? (hostKey ? usePaneHostsStore.getState().byKey[hostKey]?.body ?? null : null);
    if (!parent) {
      node.remove();
      return;
    }
    if (node.parentElement === parent) return;
    const focused = document.activeElement;
    if (parent.moveBefore && node.isConnected) {
      parent.moveBefore(node, null);
    } else {
      parent.append(node);
    }
    if (focused instanceof HTMLElement && node.contains(focused) && document.activeElement !== focused) {
      focused.focus({ preventScroll: true });
    }
  }, [host, hostKey, node]);

  React.useLayoutEffect(() => () => node.remove(), [node]);

  return createPortal(children, node);
};
