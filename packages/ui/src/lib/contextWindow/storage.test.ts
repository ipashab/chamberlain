import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import type { PersistStorage, StateStorage } from 'zustand/middleware';
import { contextWindowRecordSchema, type ContextWindowRecord } from './layoutState';
import { createContextWindowUIStorage, readContextWindowRecord, writeContextWindowRecord } from './storage';

const memoryStorage = (): StateStorage => {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
};

const recordStorage = (raw: StateStorage): PersistStorage<ContextWindowRecord> => ({
  getItem: () => {
    const record = readContextWindowRecord(raw);
    return { state: record, version: 1 };
  },
  setItem: (_name, value) => writeContextWindowRecord(raw, contextWindowRecordSchema.parse(value.state)),
  removeItem: () => {},
});

const uiStoreSchema = z.object({ state: z.record(z.string(), z.unknown()), version: z.number() });

const readUiStore = (raw: StateStorage) => uiStoreSchema.parse(JSON.parse(String(raw.getItem('ui-store'))));

const panel = (tabId: string) => ({
  isOpen: true,
  tabs: [{ id: tabId, mode: 'git', targetPath: null, dedupeKey: tabId, label: null, touchedAt: 1 }],
  activeTabId: tabId,
  layout: { kind: 'split', id: 'split-1', axis: 'row', fractions: [0.5, 0.5], children: [{ kind: 'chat' }, { kind: 'leaf', id: 'leaf-1', tabs: [tabId], activeTabId: tabId }] },
  workspaceMode: 'chat',
  modeLayouts: {},
  touchedAt: 1,
});

const windowStorage = (raw: StateStorage, ownerId: string) => createContextWindowUIStorage({
  ownerId,
  version: 30,
  storage: () => raw,
  layoutStorage: recordStorage(raw),
  now: () => 10,
});

const hydrate = (storage: PersistStorage<unknown>) => uiStoreSchema.parse(storage.getItem('ui-store'));

const setup = () => {
  const raw = memoryStorage();
  raw.setItem('ui-store', JSON.stringify({
    version: 30,
    state: {
      theme: 'dark',
      fontSize: 14,
      contextSurfaceZones: { git: 'left' },
      contextZoneSizes: { right: 500 },
      contextPanelByDirectory: {},
    },
  }));
  writeContextWindowRecord(raw, contextWindowRecordSchema.parse({
    panels: { 'owner-0001': { byDirectory: { '/panel': panel('a') }, touchedAt: 5 } },
  }));
  return raw;
};

describe('panel window ui-store persistence', () => {
  test('reads the shared preferences with its own region trees over them', () => {
    const hydrated = hydrate(windowStorage(setup(), 'owner-0001'));

    expect(hydrated.state.theme).toBe('dark');
    const byDirectory = z.record(z.string(), z.unknown()).parse(hydrated.state.contextPanelByDirectory);
    expect(Object.keys(byDirectory)).toEqual(['/panel']);
    // Zone placement stays a shared field: the record decides only the trees.
    const placement = z.record(z.string(), z.string()).parse(hydrated.state.contextSurfaceZones);
    expect(placement.git).toBe('left');
  });

  test('writes back only what it changed, over what another window saved since', () => {
    const raw = setup();
    const storage = windowStorage(raw, 'owner-0001');
    const hydrated = hydrate(storage);
    const stored = readUiStore(raw);
    raw.setItem('ui-store', JSON.stringify({ ...stored, state: { ...stored.state, theme: 'light' } }));

    storage.setItem('ui-store', { version: 30, state: { ...hydrated.state, fontSize: 16 } });

    const after = readUiStore(raw);
    expect(after.state.fontSize).toBe(16);
    expect(after.state.theme).toBe('light');
  });

  test('keeps its tree changes out of ui-store and in its own record', () => {
    const raw = setup();
    const storage = windowStorage(raw, 'owner-0001');
    const hydrated = hydrate(storage);

    storage.setItem('ui-store', {
      version: 30,
      state: { ...hydrated.state, contextPanelByDirectory: { '/panel': panel('b') } },
    });

    const after = readUiStore(raw);
    expect(after.state.contextPanelByDirectory).toEqual({});
    const record = readContextWindowRecord(raw);
    // The Git surface keeps one tab per directory, whatever id it was stored under.
    expect(record.panels['owner-0001']?.byDirectory['/panel']?.tabs.map((tab) => tab.id)).toEqual(['git']);
  });

  test('a shared field change in one panel window writes ui-store, a tree change stays in its own entry', () => {
    const raw = setup();
    const first = windowStorage(raw, 'owner-0001');
    const second = windowStorage(raw, 'owner-0002');
    const firstState = hydrate(first).state;
    const secondState = hydrate(second).state;

    first.setItem('ui-store', { version: 30, state: { ...firstState, contextSurfaceZones: { git: 'left', file: 'bottom' } } });
    second.setItem('ui-store', { version: 30, state: { ...secondState, contextPanelByDirectory: { '/other': panel('c') } } });

    const shared = readUiStore(raw);
    expect(z.record(z.string(), z.string()).parse(shared.state.contextSurfaceZones)).toEqual({ git: 'left', file: 'bottom' });
    const record = readContextWindowRecord(raw);
    expect(Object.keys(record.panels).sort()).toEqual(['owner-0001', 'owner-0002']);
    expect(record.panels['owner-0001']?.byDirectory['/panel']?.tabs.map((tab) => tab.id)).toEqual(['git']);
    expect(record.panels['owner-0002']?.byDirectory['/other']?.tabs.map((tab) => tab.id)).toEqual(['git']);
  });
});
