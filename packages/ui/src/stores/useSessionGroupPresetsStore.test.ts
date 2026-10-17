import { beforeEach, describe, expect, mock, test } from 'bun:test';

import type { GroupApplyRule, GroupPreset, GroupPresetSnapshot } from '@/lib/session-groups/groupPresetsApi';

const saveCalls: Array<GroupPresetSnapshot & { removed?: string[] }> = [];
let fetchCount = 0;
let fetchResult: GroupPresetSnapshot | null = { version: 1, presets: {} };
let saveFails = false;

mock.module('@/lib/session-groups/groupPresetsApi', () => ({
  DEFAULT_GROUP_APPLY_RULE: 'ask',
  fetchGroupPresetSnapshot: async (): Promise<GroupPresetSnapshot> => {
    fetchCount += 1;
    if (fetchResult === null) throw new Error('network down');
    return fetchResult;
  },
  saveGroupPresetSnapshot: async (snapshot: GroupPresetSnapshot): Promise<void> => {
    saveCalls.push(snapshot);
    if (saveFails) throw new Error('disk full');
  },
  normalizeGroupPreset: (preset: Partial<GroupPreset> & { folderId: string }): GroupPreset => ({
    folderId: preset.folderId,
    defaultAgent: preset.defaultAgent ?? null,
    applyRule: preset.applyRule ?? 'ask',
  }),
}));

const { useSessionGroupPresetsStore } = await import('./useSessionGroupPresetsStore');

const preset = (folderId: string, defaultAgent: string | null, applyRule: GroupApplyRule = 'ask'): GroupPreset => ({
  folderId,
  defaultAgent,
  applyRule,
  updatedAt: 1,
});

describe('useSessionGroupPresetsStore', () => {
  beforeEach(() => {
    saveCalls.length = 0;
    fetchCount = 0;
    fetchResult = { version: 1, presets: {} };
    saveFails = false;
    useSessionGroupPresetsStore.setState({ presets: {}, loaded: false, loadError: null });
  });

  test('hydrates presets from the server', async () => {
    fetchResult = { version: 1, presets: { f1: preset('f1', 'writer') } };
    await useSessionGroupPresetsStore.getState().hydrate();
    const state = useSessionGroupPresetsStore.getState();
    expect(state.loaded).toBe(true);
    expect(state.loadError).toBeNull();
    expect(state.getFolderPreset('f1')?.defaultAgent).toBe('writer');
  });

  test('records a load failure as an error, never as an empty success', async () => {
    fetchResult = null;
    await useSessionGroupPresetsStore.getState().hydrate();
    const state = useSessionGroupPresetsStore.getState();
    expect(state.loaded).toBe(false);
    expect(state.loadError).toBe('network down');
  });

  test('sets a preset and writes the whole table through', async () => {
    useSessionGroupPresetsStore.getState().setFolderPreset('f1', 'writer');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(saveCalls.length).toBe(1);
    const saved = saveCalls[0]?.presets.f1;
    expect(saved?.folderId).toBe('f1');
    expect(saved?.defaultAgent).toBe('writer');
    expect(saved?.applyRule).toBe('ask');
    expect(useSessionGroupPresetsStore.getState().getFolderPreset('f1')?.defaultAgent).toBe('writer');
  });

  test('keeps the apply rule when only the agent changes', () => {
    useSessionGroupPresetsStore.setState({ presets: { f1: preset('f1', 'writer', 'always') } });
    useSessionGroupPresetsStore.getState().setFolderPreset('f1', 'reviewer');
    expect(useSessionGroupPresetsStore.getState().getFolderPreset('f1')?.applyRule).toBe('always');
  });

  test('treats a preset without an agent as no preset at all', () => {
    useSessionGroupPresetsStore.setState({ presets: { f1: preset('f1', null) } });
    expect(useSessionGroupPresetsStore.getState().getFolderPreset('f1')).toBeNull();
  });

  test('clearing a folder removes its preset and carries the delete until confirmed', async () => {
    useSessionGroupPresetsStore.setState({
      presets: { f1: preset('f1', 'writer'), f2: preset('f2', 'reviewer') },
    });
    useSessionGroupPresetsStore.getState().clearFolderPreset('f1');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const saved = saveCalls[0];
    const savedKeys = Object.keys(saved?.presets ?? {});
    expect(savedKeys).toEqual(['f2']);
    expect(saved?.removed).toEqual(['f1']);
    expect(useSessionGroupPresetsStore.getState().presets.f1).toBeUndefined();
  });

  test('a delete rides along with the next write until the server confirmed it', async () => {
    useSessionGroupPresetsStore.setState({
      presets: { f1: preset('f1', 'writer'), f2: preset('f2', 'reviewer') },
    });
    saveFails = true;
    useSessionGroupPresetsStore.getState().clearFolderPreset('f1');
    await new Promise((resolve) => setTimeout(resolve, 20));
    saveFails = false;
    saveCalls.length = 0;
    // Whatever change comes next must still name f1 for deletion, or the
    // server-side merge would put it back.
    useSessionGroupPresetsStore.getState().setFolderPreset('f2', 'editor');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(saveCalls[0]?.removed).toEqual(['f1']);
  });

  test('a failed save rehydrates the server table', async () => {
    fetchResult = { version: 1, presets: { f1: preset('f1', 'writer') } };
    saveFails = true;
    // The counts the failed save's rehydration will move; capture them here.
    useSessionGroupPresetsStore.getState().setFolderPreset('f1', 'reviewer');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchCount).toBeGreaterThan(0);
    expect(useSessionGroupPresetsStore.getState().getFolderPreset('f1')?.defaultAgent).toBe('writer');
  });
});
