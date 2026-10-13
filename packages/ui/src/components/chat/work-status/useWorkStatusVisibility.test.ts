import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

type ZoneView = { isOpen: boolean; expanded: boolean; activeTabId: string | null };
/** The tree shape the hook reads: enough of layoutTree's WorkspaceTree. */
type PanelLayout = {
  kind: 'split';
  id: string;
  axis: 'row';
  fractions: number[];
  children: { kind: string; id?: string; tabs?: string[]; activeTabId?: string | null }[];
};
type PanelState = {
  isOpen: boolean;
  tabs: { id: string; mode: string }[];
  activeTabId: string | null;
  zones?: { left: ZoneView; bottom: ZoneView };
  layout?: PanelLayout;
};

let panelByDirectory: Record<string, PanelState> = {};
/** The store's surface placement, as far as these tests move anything. */
type SurfacePlacement = { git?: 'left' };
let surfaceZones: SurfacePlacement = {};
let panelEnabled = true;
let effectiveDirectory: string | undefined = '/repo';

/** A workspace tree with one leaf at the row's end edge showing `tab-1`. */
const layoutCoveringEdge: PanelLayout = {
  kind: 'split',
  id: 'root-split',
  axis: 'row',
  fractions: [0.7, 0.3],
  children: [
    { kind: 'chat' },
    { kind: 'leaf', id: 'leaf-1', tabs: ['tab-1'], activeTabId: 'tab-1' },
  ],
};

mock.module('@/stores/useUIStore', () => ({
  useUIStore: (selector: (state: unknown) => unknown) =>
    selector({ contextPanelByDirectory: panelByDirectory, contextSurfaceZones: surfaceZones, workStatusPanelEnabled: panelEnabled }),
  normalizeContextPanelDirectoryKey: (value: string) => value,
}));

mock.module('@/hooks/useEffectiveDirectory', () => ({
  useEffectiveDirectory: () => effectiveDirectory,
}));

const { useWorkStatusVisibility, WORK_STATUS_REQUIRED_ROW_WIDTH: REQUIRED } = await import(
  './useWorkStatusVisibility'
);

/** Elements the stubbed ResizeObserver was asked to observe, in order. */
let observed: unknown[] = [];
let notify: ((entries: { contentRect: { width: number } }[]) => void) | null = null;

class StubResizeObserver {
  constructor(callback: (entries: { contentRect: { width: number } }[]) => void) {
    notify = callback;
  }

  observe(element: unknown) {
    observed.push(element);
  }

  disconnect() {
    notify = null;
  }
}

const installMinimalDom = () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const setGlobal = (name: string, value: unknown) => {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  class ElementStub {}
  const documentStub: Record<string, unknown> = {
    nodeType: 9,
    defaultView: globalThis,
    activeElement: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  const container = {
    nodeType: 1,
    tagName: 'DIV',
    nodeName: 'DIV',
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    ownerDocument: documentStub,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  documentStub.documentElement = container;
  documentStub.body = container;
  setGlobal('document', documentStub);
  setGlobal('window', globalThis);
  setGlobal('location', { search: '', protocol: 'http:', hostname: 'localhost' });
  setGlobal('Element', ElementStub);
  setGlobal('HTMLElement', ElementStub);
  setGlobal('HTMLIFrameElement', ElementStub);
  setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  setGlobal('ResizeObserver', StubResizeObserver);
  setGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0));
  setGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
  return {
    container: container as unknown as Element,
    restore: () => {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
};

type Args = { isMobile: boolean; isVSCode: boolean };

/**
 * Renders the hook with a stand-in row node, attached through the returned
 * callback ref exactly as the real tree does.
 */
const renderVisibility = (args: Args, rowWidth: number) => {
  const dom = installMinimalDom();
  const root: Root = createRoot(dom.container);
  // `closest` returns null here, so the hook falls back to the row itself —
  // the fallback path is what these cases exercise.
  const rowNode = {
    getBoundingClientRect: () => ({ width: rowWidth }),
    closest: () => null,
  } as unknown as HTMLDivElement;
  const result = { visible: false, fits: false, roomy: false, renders: 0 };

  const Probe: React.FC = () => {
    const { rowRef, visible, fits, roomy } = useWorkStatusVisibility(args);
    result.visible = visible;
    result.fits = fits;
    result.roomy = roomy;
    result.renders += 1;
    React.useLayoutEffect(() => {
      rowRef(rowNode);
      return () => rowRef(null);
    }, [rowRef]);
    return null;
  };

  act(() => { root.render(React.createElement(Probe)); });
  return {
    result,
    rowNode,
    teardown: () => {
      act(() => { root.unmount(); });
      dom.restore();
    },
  };
};

/**
 * A stand-in row node whose `closest` answers through the given lookup, the
 * way the real DOM walks from the row up to the workspace row and the chat
 * area it wraps. Both new-placement tests share one stub so the suite's
 * chained-assertion count stays put.
 */
// SAFETY: the stub carries only the two members the hook reads on the row
// node (getBoundingClientRect and closest).
type StubBox = { getBoundingClientRect: () => { width: number } };
const stubRowNode = (resolve: (selector: string) => StubBox | null): HTMLDivElement =>
  ({ getBoundingClientRect: () => ({ width: 0 }), closest: resolve }) as unknown as HTMLDivElement;

beforeEach(() => {
  panelByDirectory = {};
  panelEnabled = true;
  effectiveDirectory = '/repo';
  observed = [];
  notify = null;
});

afterEach(() => {
  observed = [];
  notify = null;
});

describe('useWorkStatusVisibility', () => {
  test('shows the panel when the row can afford both columns', () => {
    const { result, teardown } = renderVisibility(
      { isMobile: false, isVSCode: false },
      REQUIRED,
    );
    expect(result.visible).toBe(true);
    teardown();
  });

  test('hides the panel when the row cannot afford both columns', () => {
    const { result, teardown } = renderVisibility(
      { isMobile: false, isVSCode: false },
      REQUIRED - 1,
    );
    expect(result.visible).toBe(false);
    teardown();
  });

  test('prefers the workspace row over both the chat area and the handed row', () => {
    // The measurement must not move when the card's own column opens: the
    // chat node it can squeeze sits inside the workspace row, whose width
    // comes from its parent. Measuring the chat re-decided the card's own
    // input on every open: column opens, chat narrows past the threshold,
    // column closes, chat widens back — forever.
    const dom = installMinimalDom();
    const root: Root = createRoot(dom.container);
    const workspaceRow = { getBoundingClientRect: () => ({ width: REQUIRED }) };
    const chatArea = { getBoundingClientRect: () => ({ width: 0 }) };
    const rowNode = stubRowNode((selector) => (selector === '[data-workspace-row]' ? workspaceRow : chatArea));
    const result = { visible: false };

    const Probe: React.FC = () => {
      const { rowRef, visible } = useWorkStatusVisibility({
        isMobile: false,
        isVSCode: false,
      });
      result.visible = visible;
      React.useLayoutEffect(() => {
        rowRef(rowNode);
        return () => rowRef(null);
      }, [rowRef]);
      return null;
    };

    act(() => { root.render(React.createElement(Probe)); });
    expect(observed).toEqual([workspaceRow]);
    expect(result.visible).toBe(true);

    act(() => { root.unmount(); });
    dom.restore();
  });

  test('keeps the card when the squeezed chat is narrow but the row is wide', () => {
    // Three regions beside the chat leave it under the threshold while the
    // row still affords the card's column. The row decides; a chat-based
    // reading re-decided the card's own input on every open — column opens,
    // chat narrows past the threshold, column closes, chat widens back,
    // forever — which showed as the column flickering against the panels.
    const dom = installMinimalDom();
    const root: Root = createRoot(dom.container);
    const workspaceRow = { getBoundingClientRect: () => ({ width: REQUIRED }) };
    const chatArea = { getBoundingClientRect: () => ({ width: REQUIRED - 400 }) };
    const rowNode = stubRowNode((selector) => (selector === '[data-workspace-row]' ? workspaceRow : chatArea));
    const result = { visible: false };

    const Probe: React.FC = () => {
      const { rowRef, visible } = useWorkStatusVisibility({
        isMobile: false,
        isVSCode: false,
      });
      result.visible = visible;
      React.useLayoutEffect(() => {
        rowRef(rowNode);
        return () => rowRef(null);
      }, [rowRef]);
      return null;
    };

    act(() => { root.render(React.createElement(Probe)); });
    // Only the row is ever observed, and the narrow chat area never vetoes
    // the card: the column opens against the panels and stays open.
    expect(observed).toEqual([workspaceRow]);
    expect(result.visible).toBe(true);

    act(() => { root.unmount(); });
    dom.restore();
  });

  test('measures a container the panel cannot resize, never the chat column', () => {
    // The measured element must not depend on whether the panel is showing:
    // otherwise hiding the panel widens it and re-shows the panel, forever.
    // In the app this is the workspace row; here `closest` finds nothing,
    // so the hook falls back to the row it was given.
    const { rowNode, teardown } = renderVisibility(
      { isMobile: false, isVSCode: false },
      REQUIRED,
    );
    expect(observed).toHaveLength(1);
    expect(observed[0]).toBe(rowNode);
    teardown();
  });

  test('reacts to a live resize across the threshold', () => {
    const { result, teardown } = renderVisibility(
      { isMobile: false, isVSCode: false },
      REQUIRED,
    );
    expect(result.visible).toBe(true);
    act(() => { notify?.([{ contentRect: { width: REQUIRED - 40 } }]); });
    expect(result.visible).toBe(false);
    act(() => { notify?.([{ contentRect: { width: REQUIRED + 200 } }]); });
    expect(result.visible).toBe(true);
    teardown();
  });

  test('yields to an open context panel while still measuring the row', () => {
    // Measurement continues so the panel can come back in the same commit that
    // reveals it. Stopping cost a frame: closing the context panel widened the
    // chat, and only then did the panel reappear and narrow it again.
    panelByDirectory = {
      '/repo': { isOpen: true, tabs: [{ id: 'tab-1', mode: 'git' }], activeTabId: 'tab-1', layout: layoutCoveringEdge },
    };
    const { result, rowNode, teardown } = renderVisibility(
      { isMobile: false, isVSCode: false },
      REQUIRED,
    );
    expect(result.visible).toBe(false);
    expect(observed).toEqual([rowNode]);
    teardown();
  });

  test('stays beside the chat while a surface is open in the left zone', () => {
    // Only the right zone shares this card's slot.
    const closed = { isOpen: false, expanded: false, activeTabId: null };
    surfaceZones = { git: 'left' };
    panelByDirectory['/repo'] = {
      isOpen: false,
      tabs: [{ id: 'tab-1', mode: 'git' }],
      activeTabId: null,
      zones: { left: { isOpen: true, expanded: false, activeTabId: 'tab-1' }, bottom: closed },
    };
    const { result, teardown } = renderVisibility({ isMobile: false, isVSCode: false }, REQUIRED);
    expect(result.visible).toBe(true);
    teardown();
    surfaceZones = {};
  });

  test('keeps reporting room for the column while the context panel covers it', () => {
    // The right slot keeps the card's column on this, so closing the context
    // panel narrows the slot straight to the card instead of to nothing first.
    panelByDirectory['/repo'] = { isOpen: true, tabs: [{ id: 'tab-1', mode: 'git' }], activeTabId: 'tab-1', layout: layoutCoveringEdge };
    const { result, teardown } = renderVisibility({ isMobile: false, isVSCode: false }, REQUIRED);
    expect(result.fits).toBe(false);
    expect(result.roomy).toBe(true);
    teardown();
  });

  test('does not re-render while the width moves on one side of the threshold', () => {
    // A sidebar animation changes the chat area's width on every frame; only
    // crossing the threshold may re-render the chat that owns this hook.
    const { result, teardown } = renderVisibility({ isMobile: false, isVSCode: false }, REQUIRED + 300);
    const rendersBefore = result.renders;
    for (let frame = 1; frame <= 12; frame += 1) {
      act(() => { notify?.([{ contentRect: { width: REQUIRED + 300 - frame * 20 } }]); });
    }
    // React may render once to confirm an unchanged state before bailing out.
    expect(result.renders).toBeLessThanOrEqual(rendersBefore + 1);
    act(() => { notify?.([{ contentRect: { width: REQUIRED - 20 } }]); });
    expect(result.renders).toBeGreaterThan(rendersBefore);
    expect(result.visible).toBe(false);
    teardown();
  });

  test('yields to the open context panel even when the chat reports on no project', () => {
    // A Chat session carries no repository, so the panel describes no
    // directory. The context panel is still keyed by the directory the app is
    // on, and looking it up under the chat's empty one answered "closed".
    panelByDirectory = {
      '/repo': { isOpen: true, tabs: [{ id: 'tab-1', mode: 'git' }], activeTabId: 'tab-1', layout: layoutCoveringEdge },
    };
    const { result, teardown } = renderVisibility({ isMobile: false, isVSCode: false }, REQUIRED);
    expect(result.visible).toBe(false);
    teardown();
  });

  test('ignores an open context panel that has no resolvable tab', () => {
    // ContextPanel renders nothing in that state, so it displaces nothing.
    panelByDirectory = { '/repo': { isOpen: true, tabs: [], activeTabId: null } };
    const { result, teardown } = renderVisibility(
      { isMobile: false, isVSCode: false },
      REQUIRED,
    );
    expect(result.visible).toBe(true);
    teardown();
  });

  test('measures a row that attaches after the first render', () => {
    // Regression: with an object ref the measuring effect read `.current`
    // once, found nothing when the row mounted late, and only recovered when
    // some unrelated dependency changed — in practice, opening and closing the
    // context panel. The panel must appear as soon as the row exists.
    const dom = installMinimalDom();
    const root: Root = createRoot(dom.container);
    const rowNode = {
      getBoundingClientRect: () => ({ width: REQUIRED }),
      closest: () => null,
    } as unknown as HTMLDivElement;
    const result = { visible: false };
    let attach: (value: boolean) => void = () => undefined;

    const Probe: React.FC = () => {
      const [attached, setAttached] = React.useState(false);
      const { rowRef, visible } = useWorkStatusVisibility({
        isMobile: false,
        isVSCode: false,
      });
      result.visible = visible;
      attach = setAttached;
      React.useLayoutEffect(() => {
        if (attached) rowRef(rowNode);
      }, [attached, rowRef]);
      return null;
    };

    act(() => { root.render(React.createElement(Probe)); });
    expect(result.visible).toBe(false);

    act(() => { attach(true); });
    expect(result.visible).toBe(true);

    act(() => { root.unmount(); });
    dom.restore();
  });

  test('stays hidden when the user switched the panel off, but still reports the fit', () => {
    // The header offers the panel as an overlay when layout refuses it, so it
    // needs the two answers apart: whether the user wants it, and whether
    // there is room for it.
    panelEnabled = false;
    const { result, teardown } = renderVisibility(
      { isMobile: false, isVSCode: false },
      REQUIRED * 2,
    );
    expect(result.visible).toBe(false);
    expect(result.fits).toBe(true);
    teardown();
  });

  test('reports no fit when the row is too narrow, whatever the switch says', () => {
    const { result, teardown } = renderVisibility(
      { isMobile: false, isVSCode: false },
      REQUIRED - 1,
    );
    expect(result.fits).toBe(false);
    expect(result.visible).toBe(false);
    teardown();
  });

  test('stays hidden on mobile and in VS Code regardless of width', () => {
    const mobile = renderVisibility(
      { isMobile: true, isVSCode: false },
      REQUIRED * 2,
    );
    expect(mobile.result.visible).toBe(false);
    mobile.teardown();

    observed = [];
    const vscode = renderVisibility(
      { isMobile: false, isVSCode: true },
      REQUIRED * 2,
    );
    expect(vscode.result.visible).toBe(false);
    vscode.teardown();
  });
});
