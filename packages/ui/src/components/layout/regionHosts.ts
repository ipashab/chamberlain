import { create } from 'zustand';

/**
 * The elements each region frame (`ContextPanel`) gives the surfaces that
 * live outside it. Keep-alive surfaces (the file editor, diffs, the terminal,
 * browser tabs, ...) are mounted once in `ContextSurfacePanes` and portalled
 * into the body of the region (layout leaf) that holds their tab, so moving a
 * tab between regions moves its DOM instead of remounting it.
 *
 * Keyed by leaf id, not by a fixed zone slot: the layout tree holds any
 * number of regions and their ids are the one stable identity a tree
 * rewrite never changes.
 */
type RegionSlot = { body: HTMLElement | null; headerSlot: HTMLElement | null };

type PaneHostsState = {
  /** Where a region's surface content goes, by region. */
  byKey: Record<string, RegionSlot>;
};

export const usePaneHostsStore = create<PaneHostsState>(() => ({
  byKey: {},
}));

const slotOf = (state: PaneHostsState, key: string): RegionSlot =>
  state.byKey[key] ?? { body: null, headerSlot: null };

const setSlot = (key: string, patch: Partial<RegionSlot>): void => {
  const state = usePaneHostsStore.getState();
  const current = slotOf(state, key);
  const next = { ...current, ...patch };
  if (current.body === next.body && current.headerSlot === next.headerSlot) return;
  usePaneHostsStore.setState({ byKey: { ...state.byKey, [key]: next } });
};

export const setRegionBody = (key: string, element: HTMLElement | null): void =>
  setSlot(key, { body: element });

export const setRegionHeaderSlot = (key: string, element: HTMLElement | null): void =>
  setSlot(key, { headerSlot: element });
